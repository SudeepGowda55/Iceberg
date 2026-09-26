// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title IcebergMath
/// @notice Shared kernel of the Partially Active AMM (PA-AMM, Ko 2026, arXiv 2602.09887) used by both venues:
///         the 1inch Aqua instruction (PAActiveReserves) and the Uniswap v4 hook (IcebergHook).
/// @dev All values are 1e18 fixed point ("wad"). Rounding always favours the maker / LP:
///      the active (tradable) share rounds DOWN, so the passive share can only be larger than exact.
///      Every function is total over its documented domain and never reverts on in-range input;
///      out-of-range inputs are clipped, so a pricing call cannot freeze swaps.
library IcebergMath {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    /// @dev ln(2) in wad, the clip bound for the log-price gap
    int256 internal constant LN2_WAD = 693147180559945309;

    // ---------------------------------------------------------------------------------------------------------
    // Algorithm 1: active / passive split
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Split a reserve into the part that may trade this block and the part that sits out
    /// @param total Total reserve of one token
    /// @param lambdaWad Activeness λ in wad, clipped to [0, 1]
    /// @return active floor(total * λ), the tradable part
    /// @return passive total - active, never smaller than the exact passive share
    function split(uint256 total, uint256 lambdaWad) internal pure returns (uint256 active, uint256 passive) {
        if (lambdaWad > WAD) lambdaWad = WAD;
        active = Math.mulDiv(total, lambdaWad, WAD);
        passive = total - active;
    }

    // ---------------------------------------------------------------------------------------------------------
    // λ policies
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Closed-form optimal fixed activeness λ*(γ) = (1 + √(1+2γ)) / (1 + γ + √(1+2γ))
    /// @param gammaWad γ = γ' / (2θ(1-θ)), the weight of LVR against tracking error, in wad
    function lambdaStar(uint256 gammaWad) internal pure returns (uint256) {
        uint256 s = _sqrtWad(WAD + 2 * gammaWad); // √(1+2γ) in wad
        return Math.mulDiv(WAD + s, WAD, WAD + gammaWad + s);
    }

    /// @notice v2 of the quadratic value function, closed form of v2 = γ - γ²/(4(1+v2)) at β → 1:
    ///         v2 = (γ - 1 + √(1+2γ)) / 2
    function v2Of(uint256 gammaWad) internal pure returns (uint256) {
        uint256 s = _sqrtWad(WAD + 2 * gammaWad);
        return (gammaWad + s - WAD) / 2; // s >= 1, so this never underflows
    }

    /// @notice Theorem 1 state-dependent policy at β → 1:
    ///         λ(g) = clip(λ*(γ) + (2·v2·m + v1) / (2(1+v2)) · 1/g, λmin, 1),  v1 = γ·v2·m / ((1+v2)·λ*)
    /// @dev With zero drift (m = 0) this is exactly λ*(γ): the state dependence only reacts to drift
    /// @param gammaWad γ in wad
    /// @param mWad Expected log-price drift per block (μΔt) in wad, signed
    /// @param gWad Current log-price gap g = log(reference) - log(pool) in wad, signed
    /// @param lminWad Lower clip λmin in wad
    function lambdaTheorem1(uint256 gammaWad, int256 mWad, int256 gWad, uint256 lminWad) internal pure returns (uint256) {
        uint256 base = lambdaStar(gammaWad);
        if (mWad == 0 || gWad == 0) return _clip(int256(base), lminWad);
        int256 v2 = int256(v2Of(gammaWad));
        int256 onePlusV2 = IWAD + v2;
        // v1 = γ·v2·m / ((1+v2)·λ*)
        int256 v1 = (((int256(gammaWad) * v2) / IWAD) * mWad / IWAD) * IWAD / onePlusV2 * IWAD / int256(base);
        // tilt = (2·v2·m + v1) / (2(1+v2) · g)
        int256 num = 2 * (v2 * mWad / IWAD) + v1;
        int256 tilt = num * IWAD / (2 * onePlusV2) * IWAD / gWad;
        return _clip(int256(base) + tilt, lminWad);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Prices and the log-price gap
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Price of tokenA in tokenB (whole units) from raw balances, both sides normalised to 18 decimals
    /// @dev WETH (18) / USDC (6): balances 1e18 WETH and 2_700e6 USDC give 2_700e18
    function priceWad(uint256 balA, uint8 decA, uint256 balB, uint8 decB) internal pure returns (uint256) {
        uint256 a = balA * (10 ** (18 - decA));
        uint256 b = balB * (10 ** (18 - decB));
        return Math.mulDiv(b, WAD, a);
    }

    /// @notice Price of currency0 in currency1 (whole units, 1e18) from a Uniswap v4 sqrtPriceX96
    function priceFromSqrtX96(uint160 sqrtPriceX96, uint8 dec0, uint8 dec1) internal pure returns (uint256) {
        uint256 raw = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96); // raw1/raw0 · 2^96
        uint256 p = Math.mulDiv(raw, WAD, 1 << 96);                                      // raw1/raw0 in wad
        return dec0 >= dec1 ? p * (10 ** (dec0 - dec1)) : p / (10 ** (dec1 - dec0));
    }

    /// @notice Log-price gap g = ln(pRef / pPool) in wad, clipped to ±ln 2
    function gap(uint256 pPoolWad, uint256 pRefWad) internal pure returns (int256) {
        if (pPoolWad == 0 || pRefWad == 0) return 0;
        uint256 r = Math.mulDiv(pRefWad, WAD, pPoolWad);
        if (r >= 2 * WAD) return LN2_WAD;
        if (r <= WAD / 2) return -LN2_WAD;
        return lnWad(r);
    }

    /// @notice Natural log for r in [0.5, 2] (wad) via ln r = 2·atanh((r-1)/(r+1)), nine odd terms
    /// @dev |z| <= 1/3 on this domain; the first omitted term is 2·z^19/19 < 1e-10, so absolute error < 1e-10
    function lnWad(uint256 r) internal pure returns (int256) {
        int256 z = (int256(r) - IWAD) * IWAD / (int256(r) + IWAD);
        int256 z2 = z * z / IWAD;
        int256 term = z;
        int256 sum = z;
        for (int256 k = 3; k <= 17; k += 2) {
            term = term * z2 / IWAD;
            sum += term / k;
        }
        return 2 * sum;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Constant-product quote on the active pair (used by the v4 hook; the Aqua path uses 1inch's XYCSwap)
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Exact-in output on x·y = k over the active reserves after a fee on the input; floor favours the LP
    function xycOut(uint256 activeIn, uint256 activeOut, uint256 amountIn, uint256 feePips) internal pure returns (uint256) {
        uint256 net = amountIn - Math.mulDiv(amountIn, feePips, 1_000_000, Math.Rounding.Ceil);
        return Math.mulDiv(net, activeOut, activeIn + net);
    }

    // ---------------------------------------------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------------------------------------------

    function _clip(int256 lambdaWad, uint256 lminWad) private pure returns (uint256) {
        if (lambdaWad < int256(lminWad)) return lminWad;
        if (lambdaWad > IWAD) return WAD;
        return uint256(lambdaWad);
    }

    /// @dev √x for x in wad, result in wad
    function _sqrtWad(uint256 x) private pure returns (uint256) {
        return Math.sqrt(x * WAD);
    }
}
