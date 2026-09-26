// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IcebergMath } from "./IcebergMath.sol";
import { ILambdaSource } from "./ILambdaSource.sol";
import { IIcebergParams } from "./IcebergParams.sol";
import { UniV4PegSwap } from "./UniV4PegSwap.sol";

/// @title Theorem1Source
/// @notice The paper's state-dependent policy (Ko 2026, Theorem 1) as an ILambdaSource:
///         λ(g) = clip(λ*(γ) + (2·v2·m + v1) / (2(1+v2)) · 1/g, λmin, 1)
///         with g = ln(v4 reference price / strategy price) read live from a Uniswap v4 pool, and the drift m taken
///         from the keeper's IcebergParams entry (0 if unset, in which case λ = λ*(γ) exactly).
/// @dev On 7 days of real ETH/USD prices this policy is indistinguishable from the fixed λ*(γ) (research/lambda_policy.mjs);
///      it is provided as a faithful implementation of the paper, not as the recommended default.
contract Theorem1Source is ILambdaSource {
    IIcebergParams public immutable params;
    uint256 public immutable gammaWad;
    uint256 public immutable lminWad;
    address public immutable poolManager;
    bytes32 public immutable poolId;
    /// @dev the strategy token that is the v4 pool's currency1 (e.g. USDC for native-ETH/USDC); the other side is currency0
    address public immutable currency1Token;

    constructor(IIcebergParams params_, uint256 gammaWad_, uint256 lminWad_, address poolManager_, bytes32 poolId_, address currency1Token_) {
        params = params_; gammaWad = gammaWad_; lminWad = lminWad_; poolManager = poolManager_; poolId = poolId_; currency1Token = currency1Token_;
    }

    /// @inheritdoc ILambdaSource
    function lambdaOf(address maker, bytes32 orderHash, address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut)
        external view returns (uint256, bool)
    {
        bool inIsC1 = tokenIn == currency1Token;
        if (!inIsC1 && tokenOut != currency1Token) return (0, false);
        address other = inIsC1 ? tokenOut : tokenIn;
        uint8 dOther = IERC20Metadata(other).decimals();
        uint8 dC1 = IERC20Metadata(currency1Token).decimals();
        uint256 pPool = IcebergMath.priceWad(inIsC1 ? balanceOut : balanceIn, dOther, inIsC1 ? balanceIn : balanceOut, dC1);
        uint256 pRef = IcebergMath.priceFromSqrtX96(UniV4PegSwap.sqrtPriceX96(poolManager, poolId), dOther, dC1);
        int256 g = IcebergMath.gap(pPool, pRef);
        (, int64 drift, bool set) = params.get(maker, orderHash);
        return (IcebergMath.lambdaTheorem1(gammaWad, set ? int256(drift) : int256(0), g, lminWad), true);
    }
}
