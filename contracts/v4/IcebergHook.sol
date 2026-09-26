// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BaseHook } from "uniswap-hooks/src/base/BaseHook.sol";
import { BaseCustomCurve } from "uniswap-hooks/src/base/BaseCustomCurve.sol";
import { CurrencySettler } from "uniswap-hooks/src/utils/CurrencySettler.sol";
import { IcebergMath } from "../iceberg/IcebergMath.sol";
import { ILambdaSource } from "../iceberg/ILambdaSource.sol";

interface IIcebergParamsAdmin { function setKeeper(address keeper, uint64 minWad, uint64 maxWad) external; }

/// @title IcebergHook
/// @notice Partially Active AMM (Ko 2026, arXiv 2602.09887, Algorithm 1) as a Uniswap v4 hook, built on
///         OpenZeppelin's BaseCustomCurve. The hook owns the pool's reserves (as ERC-6909 claims in the PoolManager)
///         and prices every swap on a constant-product curve over the ACTIVE reserves only:
///           - on the first swap of each block, total reserves R are split into active λ·R and passive (1-λ)·R;
///           - the passive part is frozen for the rest of the block, so an arbitrageur only ever sees λ of the pool;
///           - λ comes from the same pluggable ILambdaSource as the 1inch Aqua instruction (fee-aware keeper or the
///             paper's Theorem 1), gas-capped with a fallback, clipped to [λmin, 1].
///         Idle (passive) reserves can be parked in ERC-4626 vaults (Morpho) by the owner or keeper and brought back
///         before they are needed. A swap whose output exceeds the hook's in-pool claims reverts (fails closed).
/// @dev Same kernel as the Aqua venue: IcebergMath.split and constant product with a fee on the input.
///      LP shares are this ERC-20. Exact-input and exact-output swaps are both supported.
contract IcebergHook is BaseCustomCurve, ERC20 {
    using CurrencySettler for Currency;
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    error NotOperator(address caller);
    error NotEnoughActive(uint256 amountOut, uint256 activeOut);
    error NotEnoughInPool(uint256 amountOut, uint256 claims);
    error ParkTooMuch(uint256 claimsAfter, uint256 mustKeep);
    error NoVault();
    error ZeroShares();

    uint256 internal constant PIPS = 1_000_000;
    /// @dev locked forever on the first deposit (as in Uniswap v2) so share price cannot be inflated by a donation
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 internal constant SOURCE_GAS = 600_000;
    /// @dev tags park/unpark unlock data (128 bytes) so it can never be confused with liquidity callbacks (96 bytes)
    bytes32 internal constant VAULT_OP = keccak256("iceberg.vault.op");

    address public immutable owner;
    /// @dev swap fee on the input, in pips (500 = 5 bps); stays in the pool for LPs
    uint24 public immutable feePips;
    uint64 public immutable fallbackLambdaWad;
    uint64 public immutable lminWad;
    /// @dev λ ceiling used for parking: at most (1 - maxLambda) of each reserve may ever sit in a vault
    uint64 public immutable maxLambdaWad;
    ILambdaSource public immutable lambdaSource;
    IERC4626 public immutable vault0;
    IERC4626 public immutable vault1;
    address public keeper;

    // per-block split
    uint64 public splitBlock;
    uint256 public passive0;
    uint256 public passive1;
    uint256 public lastLambdaWad;
    // parked in vaults (in vault shares)
    uint256 public parkedShares0;
    uint256 public parkedShares1;

    event Split(uint256 indexed blockNumber, uint256 lambdaWad, uint256 passive0, uint256 passive1);
    event Parked(uint8 indexed side, uint256 assets, uint256 shares);
    event Unparked(uint8 indexed side, uint256 assets, uint256 shares);
    event KeeperSet(address keeper);

    struct Config {
        address owner;
        uint24 feePips;
        uint64 fallbackLambdaWad;
        uint64 lminWad;
        uint64 maxLambdaWad;
        ILambdaSource lambdaSource;
        IERC4626 vault0;
        IERC4626 vault1;
    }

    constructor(IPoolManager pm, Config memory c) BaseHook(pm) ERC20("Iceberg PA-AMM LP", "ICE-LP") {
        owner = c.owner; feePips = c.feePips; fallbackLambdaWad = c.fallbackLambdaWad; lminWad = c.lminWad;
        maxLambdaWad = c.maxLambdaWad; lambdaSource = c.lambdaSource; vault0 = c.vault0; vault1 = c.vault1;
    }

    modifier onlyOperator() {
        require(msg.sender == owner || (keeper != address(0) && msg.sender == keeper), NotOperator(msg.sender));
        _;
    }

    /// @notice Owner picks the keeper. The hook is its own "maker" in the λ source, so it also registers the keeper
    ///         there with this pool's bounds: the keeper can never publish λ above maxλ (the parking guarantee) or below λmin.
    function setKeeper(address k) external {
        require(msg.sender == owner, NotOperator(msg.sender));
        keeper = k;
        try IIcebergParamsAdmin(address(lambdaSource)).setKeeper(k, lminWad, maxLambdaWad) { } catch { }
        emit KeeperSet(k);
    }

    // ------------------------------------------------------------------------------------------ reserves

    /// @notice Hook's reserves still inside the PoolManager (ERC-6909 claims), per currency
    function claims() public view returns (uint256 c0, uint256 c1) {
        PoolKey memory k = poolKey();
        c0 = poolManager.balanceOf(address(this), k.currency0.toId());
        c1 = poolManager.balanceOf(address(this), k.currency1.toId());
    }

    /// @notice Total reserves: claims in the pool plus assets parked in vaults
    function reserves() public view returns (uint256 r0, uint256 r1) {
        (uint256 c0, uint256 c1) = claims();
        r0 = c0 + (parkedShares0 == 0 ? 0 : vault0.convertToAssets(parkedShares0));
        r1 = c1 + (parkedShares1 == 0 ? 0 : vault1.convertToAssets(parkedShares1));
    }

    /// @notice Active reserves for the current block (what a swap in this block can see)
    function activeReserves() public view returns (uint256 a0, uint256 a1, uint256 lambdaWad) {
        (uint256 r0, uint256 r1) = reserves();
        uint256 p0; uint256 p1;
        if (splitBlock == block.number) { p0 = passive0; p1 = passive1; lambdaWad = lastLambdaWad; }
        else { lambdaWad = _lambda(r0, r1); (, p0) = IcebergMath.split(r0, lambdaWad); (, p1) = IcebergMath.split(r1, lambdaWad); }
        a0 = _capToDeliverable(0, r0 > p0 ? r0 - p0 : 0);
        a1 = _capToDeliverable(1, r1 > p1 ? r1 - p1 : 0);
    }

    /// @dev Cheap path: if the active side fits in the pool's claims, no vault read (MetaMorpho maxWithdraw ~300k gas)
    function _capToDeliverable(uint8 side, uint256 active) internal view returns (uint256) {
        (uint256 c0, uint256 c1) = claims();
        if (active <= (side == 0 ? c0 : c1)) return active;
        return Math.min(active, _deliverable(side));
    }

    /// @notice What the hook can actually hand out right now: claims in the pool plus what its vault will release.
    ///         The active side is capped by it, so the curve never quotes an output the hook could not deliver.
    function _deliverable(uint8 side) internal view returns (uint256) {
        (uint256 c0, uint256 c1) = claims();
        IERC4626 v = side == 0 ? vault0 : vault1;
        uint256 parked = side == 0 ? parkedShares0 : parkedShares1;
        uint256 fromVault = parked == 0 ? 0 : Math.min(v.maxWithdraw(address(this)), v.convertToAssets(parked));
        return (side == 0 ? c0 : c1) + fromVault;
    }

    /// @dev Inside a swap (the PoolManager is unlocked): withdraw from the vault and turn it into pool claims
    function _unparkInSwap(uint8 side, uint256 assets) internal {
        IERC4626 v = side == 0 ? vault0 : vault1;
        uint256 shares = v.withdraw(assets, address(this), address(this));
        if (side == 0) parkedShares0 -= shares; else parkedShares1 -= shares;
        Currency c = side == 0 ? poolKey().currency0 : poolKey().currency1;
        c.settle(poolManager, address(this), assets, false); // pay the real tokens in
        c.take(poolManager, address(this), assets, true);    // and hold them as claims
        emit Unparked(side, assets, shares);
    }

    function _refreshSplit() internal returns (uint256 a0, uint256 a1) {
        (uint256 r0, uint256 r1) = reserves();
        if (splitBlock != block.number) {
            uint256 l = _lambda(r0, r1);
            (, uint256 p0) = IcebergMath.split(r0, l);
            (, uint256 p1) = IcebergMath.split(r1, l);
            splitBlock = uint64(block.number); passive0 = p0; passive1 = p1; lastLambdaWad = l;
            emit Split(block.number, l, p0, p1);
        }
        a0 = _capToDeliverable(0, r0 > passive0 ? r0 - passive0 : 0);
        a1 = _capToDeliverable(1, r1 > passive1 ? r1 - passive1 : 0);
    }

    function _lambda(uint256 r0, uint256 r1) internal view returns (uint256 l) {
        l = fallbackLambdaWad;
        if (address(lambdaSource) != address(0)) {
            PoolKey memory k = poolKey();
            try lambdaSource.lambdaOf{ gas: SOURCE_GAS }(address(this), PoolId.unwrap(k.toId()), Currency.unwrap(k.currency1), Currency.unwrap(k.currency0), r1, r0)
                returns (uint256 s, bool ok) { if (ok) l = s; } catch { }
        }
        if (l > 1e18) l = 1e18;
        if (l < lminWad) l = lminWad;
    }

    // ------------------------------------------------------------------------------------------ swap curve

    /// @inheritdoc BaseCustomCurve
    function _getUnspecifiedAmount(SwapParams calldata params) internal override returns (uint256 unspecified) {
        (uint256 a0, uint256 a1) = _refreshSplit();
        bool exactIn = params.amountSpecified < 0;
        (uint256 aIn, uint256 aOut) = params.zeroForOne ? (a0, a1) : (a1, a0);
        (uint256 c0, uint256 c1) = claims();
        uint256 cOut = params.zeroForOne ? c1 : c0;
        uint8 outSide = params.zeroForOne ? 1 : 0;
        uint256 amountOut;
        if (exactIn) {
            uint256 amountIn = uint256(-params.amountSpecified);
            unspecified = IcebergMath.xycOut(aIn, aOut, amountIn, feePips);
            require(unspecified < aOut, NotEnoughActive(unspecified, aOut));
            amountOut = unspecified;
        } else {
            amountOut = uint256(params.amountSpecified);
            require(amountOut < aOut, NotEnoughActive(amountOut, aOut));
        }
        // the active side is capped by what can be delivered; pull any shortfall out of Morpho inside the swap
        if (amountOut > cOut) _unparkInSwap(outSide, amountOut - cOut);
        if (!exactIn) {
            uint256 net = Math.mulDiv(amountOut, aIn, aOut - amountOut, Math.Rounding.Ceil);
            unspecified = Math.mulDiv(net, PIPS, PIPS - feePips, Math.Rounding.Ceil); // gross up for the fee; favours LPs
        }
    }

    /// @inheritdoc BaseCustomCurve
    function _getSwapFeeAmount(SwapParams calldata params, uint256 unspecified) internal view override returns (uint256) {
        uint256 grossIn = params.amountSpecified < 0 ? uint256(-params.amountSpecified) : unspecified;
        return Math.mulDiv(grossIn, feePips, PIPS, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------------------------------ liquidity (shares)

    /// @inheritdoc BaseCustomCurve
    function _getAmountIn(AddLiquidityParams memory p) internal override returns (uint256 amount0, uint256 amount1, uint256 shares) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            (amount0, amount1) = (p.amount0Desired, p.amount1Desired);
            shares = Math.sqrt(amount0 * amount1);
            require(shares > MINIMUM_LIQUIDITY, ZeroShares());
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
            shares -= MINIMUM_LIQUIDITY;
        } else {
            (uint256 r0, uint256 r1) = reserves();
            shares = Math.min(Math.mulDiv(p.amount0Desired, supply, r0), Math.mulDiv(p.amount1Desired, supply, r1));
            amount0 = Math.mulDiv(shares, r0, supply, Math.Rounding.Ceil);
            amount1 = Math.mulDiv(shares, r1, supply, Math.Rounding.Ceil);
        }
        require(shares != 0, ZeroShares());
        splitBlock = 0; // new liquidity: re-split on the next swap
    }

    /// @inheritdoc BaseCustomCurve
    function _getAmountOut(RemoveLiquidityParams memory p) internal override returns (uint256 amount0, uint256 amount1, uint256 shares) {
        shares = p.liquidity;
        uint256 supply = totalSupply();
        (uint256 r0, uint256 r1) = reserves();
        amount0 = Math.mulDiv(shares, r0, supply);
        amount1 = Math.mulDiv(shares, r1, supply);
        (uint256 c0, uint256 c1) = claims();
        // pull the LP's share of parked reserves out of Morpho first (no operator needed to exit)
        if (amount0 > c0) _unparkOutsideSwap(0, amount0 - c0);
        if (amount1 > c1) _unparkOutsideSwap(1, amount1 - c1);
        splitBlock = 0;
    }

    function _mint(AddLiquidityParams memory, BalanceDelta, BalanceDelta, uint256 shares) internal override {
        _mint(msg.sender, shares);
    }

    function _burn(RemoveLiquidityParams memory, BalanceDelta, BalanceDelta, uint256 shares) internal override {
        _burn(msg.sender, shares);
    }

    // ------------------------------------------------------------------------------------------ Morpho parking

    /// @notice Move idle reserves into the vault. Never parks more than (1 - maxλ) of a reserve, so whatever λ the
    ///         keeper may choose inside its box, the active part is always in the pool.
    function park(uint8 side, uint256 assets) external onlyOperator {
        IERC4626 v = side == 0 ? vault0 : vault1;
        require(address(v) != address(0), NoVault());
        (uint256 r0, uint256 r1) = reserves();
        (uint256 c0, uint256 c1) = claims();
        uint256 r = side == 0 ? r0 : r1;
        uint256 c = side == 0 ? c0 : c1;
        uint256 mustKeep = Math.mulDiv(r, maxLambdaWad, 1e18, Math.Rounding.Ceil);
        require(c >= assets && c - assets >= mustKeep, ParkTooMuch(c - Math.min(c, assets), mustKeep));
        poolManager.unlock(abi.encode(VAULT_OP, uint8(1), side, assets));
        IERC20 t = IERC20(Currency.unwrap(side == 0 ? poolKey().currency0 : poolKey().currency1));
        t.forceApprove(address(v), assets);
        uint256 shares = v.deposit(assets, address(this));
        if (side == 0) parkedShares0 += shares; else parkedShares1 += shares;
        emit Parked(side, assets, shares);
    }

    /// @notice Bring parked reserves back into the pool as claims (all of them with type(uint256).max)
    function unpark(uint8 side, uint256 assets) external onlyOperator {
        _unparkOutsideSwap(side, assets);
    }

    function _unparkOutsideSwap(uint8 side, uint256 assets) internal {
        IERC4626 v = side == 0 ? vault0 : vault1;
        uint256 parked = side == 0 ? parkedShares0 : parkedShares1;
        uint256 shares = assets == type(uint256).max ? parked : v.previewWithdraw(assets);
        if (shares > parked) shares = parked;
        uint256 got = v.redeem(shares, address(this), address(this));
        if (side == 0) parkedShares0 -= shares; else parkedShares1 -= shares;
        poolManager.unlock(abi.encode(VAULT_OP, uint8(2), side, got));
        emit Unparked(side, got, shares);
    }

    /// @dev Routes liquidity callbacks to BaseCustomCurve and handles park (1) / unpark (2)
    function unlockCallback(bytes calldata raw) public override onlyPoolManager returns (bytes memory) {
        if (raw.length != 128 || bytes32(raw[:32]) != VAULT_OP) return super.unlockCallback(raw);
        (, uint8 op, uint8 side, uint256 amount) = abi.decode(raw, (bytes32, uint8, uint8, uint256));
        Currency c = side == 0 ? poolKey().currency0 : poolKey().currency1;
        if (op == 1) {
            c.settle(poolManager, address(this), amount, true);  // burn claims
            c.take(poolManager, address(this), amount, false);   // receive real tokens
        } else {
            c.settle(poolManager, address(this), amount, false); // pay real tokens
            c.take(poolManager, address(this), amount, true);    // mint claims
        }
        return "";
    }
}
