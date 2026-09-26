// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test, console } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SwapParams, ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { BaseCustomAccounting } from "uniswap-hooks/src/base/BaseCustomAccounting.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/instructions/FeeFlat.sol";
import { IcebergHook } from "../../contracts/v4/IcebergHook.sol";
import { IcebergMath } from "../../contracts/iceberg/IcebergMath.sol";
import { ILambdaSource } from "../../contracts/iceberg/ILambdaSource.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { PAActiveReserves } from "../../contracts/iceberg/PAActiveReserves.sol";
import { AquaTaker } from "../fork/IcebergHookFork.t.sol";

/// @title Replay of the real 24 hours ending 2026-09-21 20:31 UTC (ETH +6.24%) on a Base mainnet fork
/// @notice Every minute a rational arbitrageur trades each venue to the real Coinbase ETH/USD close (one block per
///         minute). The arbitrageur's cumulative profit is what the LPs lost (loss-versus-rebalancing net of the fees
///         they collected). Same fee (5 bps), same starting reserves (2 WETH + matching USDC) everywhere.
/// @dev Full 1,440 minutes: `REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv`
///      Default (no env): the first 120 minutes, as a smoke test inside the normal suite.
contract Replay21SepTest is Test {
    using stdJson for string;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint160 constant FLAGS = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
    uint24 constant FEE = 500; // pips = 5 bps
    uint160 constant MIN_SQRT = 4295128740;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    struct Venue { string name; uint8 kind; PoolKey key; IcebergHook hook; ISwapVM.Order order; uint256 lambda; int256 arbProfit; uint256 trades; int256 liq; int256 lpLoss; }
    // kind: 0 = plain Uniswap v4 full-range pool, 1 = Iceberg v4 hook, 2 = Iceberg 1inch Aqua position

    uint256[] px; // ETH/USD, 8 decimals
    PoolSwapTest swapper;
    IcebergRouter router;
    AquaTaker taker;
    address aquaMaker = makeAddr("aquaMaker");
    Venue[] venues;
    PoolModifyLiquidityTest lpRouter;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        string memory j = vm.readFile("research/replay_prices_2026-09-21.json");
        px = j.readUintArray(".price8");
        swapper = new PoolSwapTest(PM);
        router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "1");
        taker = new AquaTaker(AQUA, address(router));
        deal(WETH, address(this), 1_000_000 ether); deal(USDC, address(this), 1e15);
        IERC20(WETH).approve(address(swapper), type(uint256).max); IERC20(USDC).approve(address(swapper), type(uint256).max);
        deal(WETH, address(taker), 1_000_000 ether); deal(USDC, address(taker), 1e15);
    }

    // ------------------------------------------------------------------ venue setup

    function _usdcFor(uint256 weth, uint256 p8) internal pure returns (uint256) { return weth * p8 / 1e20; }

    function _plainV4(uint256 p8) internal returns (Venue memory v) {
        PoolKey memory key = PoolKey(Currency.wrap(WETH), Currency.wrap(USDC), FEE, 10, IHooks(address(0)));
        // a fresh pool: fee 500 / tickSpacing 10 with no hook is the canonical 0.05% pool id, so use a distinct spacing
        key.tickSpacing = 11;
        PM.initialize(key, _sqrtX96(p8));
        lpRouter = new PoolModifyLiquidityTest(PM);
        IERC20(WETH).approve(address(lpRouter), type(uint256).max); IERC20(USDC).approve(address(lpRouter), type(uint256).max);
        // full-range liquidity L = sqrt(x·y) for 2 WETH + matching USDC
        int256 liq = int256(Math.sqrt(2 ether * _usdcFor(2 ether, p8)));
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams({ tickLower: -887205, tickUpper: 887205, liquidityDelta: liq, salt: 0 }), "");
        v.name = "plain Uniswap v4 pool (full range)"; v.kind = 0; v.key = key; v.lambda = 1e18; v.liq = liq;
    }

    function _hook(uint256 p8, uint64 lambda, uint256 n) internal returns (Venue memory v) {
        address at = address(FLAGS | (uint160(0xBA11A5 + n) << 136));
        IcebergHook.Config memory c = IcebergHook.Config(address(this), FEE, lambda, 0.1e18, 1e18, ILambdaSource(address(0)), IERC4626(address(0)), IERC4626(address(0)));
        deployCodeTo("IcebergHook.sol:IcebergHook", abi.encode(PM, c), at);
        v.hook = IcebergHook(at);
        v.key = PoolKey(Currency.wrap(WETH), Currency.wrap(USDC), 0, 60, IHooks(at));
        PM.initialize(v.key, 79228162514264337593543950336);
        IERC20(WETH).approve(at, type(uint256).max); IERC20(USDC).approve(at, type(uint256).max);
        v.hook.addLiquidity(BaseCustomAccounting.AddLiquidityParams(2 ether, _usdcFor(2 ether, p8), 0, 0, block.timestamp, 0, 0, bytes32(0)));
        v.kind = 1; v.lambda = lambda;
        v.name = string.concat("Iceberg v4 hook, lambda ", vm.toString(uint256(lambda) / 1e16), "%");
    }

    function _aqua(uint256 p8, uint64 lambda) internal returns (Venue memory v) {
        bytes memory program = bytes.concat(PAActiveReserves.fixedLambda(lambda), FeeFlatIn.build(0.0005e7), XYCSwap.build());
        v.order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: aquaMaker, tokenA: WETH, tokenB: USDC, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false,
            receiver: address(0), hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "", program: program
        }));
        uint256 u = _usdcFor(2 ether, p8);
        deal(WETH, aquaMaker, 2 ether); deal(USDC, aquaMaker, u);
        vm.startPrank(aquaMaker);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory a = new uint256[](2); a[0] = 2 ether; a[1] = u;
        AQUA.ship(address(router), abi.encode(v.order), t, a);
        vm.stopPrank();
        v.kind = 2; v.lambda = lambda;
        v.name = string.concat("Iceberg 1inch Aqua position, lambda ", vm.toString(uint256(lambda) / 1e16), "%");
    }

    // ------------------------------------------------------------------ arbitrage

    /// @dev sqrtPriceX96 of USDC-per-WETH (raw units) for a USD price with 8 decimals
    function _sqrtX96(uint256 p8) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(p8, 1 << 192, 1e20)));
    }

    function _value(uint256 weth, uint256 p8) internal pure returns (int256) { return int256(weth * p8 / 1e20); }

    function _arbPlain(Venue storage v, uint256 p8) internal {
        (uint160 sq,,,) = PM.getSlot0(v.key.toId());
        uint160 buyBelow = _sqrtX96(p8 * (1e6 - FEE) / 1e6);  // pool price below s(1-f): buy WETH
        uint160 sellAbove = _sqrtX96(p8 * 1e6 / (1e6 - FEE)); // pool price above s/(1-f): sell WETH
        bool zeroForOne;
        uint160 limit;
        if (sq < buyBelow) { zeroForOne = false; limit = buyBelow; }
        else if (sq > sellAbove) { zeroForOne = true; limit = sellAbove; }
        else return;
        BalanceDelta d = swapper.swap(v.key, SwapParams({ zeroForOne: zeroForOne, amountSpecified: -1e30, sqrtPriceLimitX96: limit }), PoolSwapTest.TestSettings(false, false), "");
        int256 dWeth = d.amount0(); int256 dUsdc = d.amount1(); // negative = paid by the arbitrageur
        v.arbProfit += _value(uint256(dWeth > 0 ? dWeth : -dWeth), p8) * (dWeth > 0 ? int256(1) : int256(-1)) + dUsdc;
        v.trades++;
    }

    /// @dev Arbitrage on a constant-product active pair with a fee on the input, to s(1-f) or s/(1-f)
    function _arbAmount(uint256 aW, uint256 aU, uint256 p8) internal pure returns (bool buyWeth, uint256 grossIn) {
        // pool price and market price as USDC-raw per WETH-raw, scaled by 1e36
        uint256 p = Math.mulDiv(aU, 1e36, aW);
        uint256 s = p8 * 1e16; // p8 / 1e8 * 1e6 / 1e18 * 1e36
        uint256 k = aW * aU;
        if (p * 1e6 < s * (1e6 - FEE)) {
            uint256 target = s * (1e6 - FEE) / 1e6;
            uint256 newU = Math.sqrt(Math.mulDiv(k, target, 1e36));
            if (newU <= aU) return (true, 0);
            return (true, (newU - aU) * 1e6 / (1e6 - FEE));
        }
        if (p * (1e6 - FEE) > s * 1e6) {
            uint256 target = s * 1e6 / (1e6 - FEE);
            uint256 newW = Math.sqrt(Math.mulDiv(k, 1e36, target));
            if (newW <= aW) return (false, 0);
            return (false, (newW - aW) * 1e6 / (1e6 - FEE));
        }
    }

    function _arbHook(Venue storage v, uint256 p8) internal {
        (uint256 aW, uint256 aU,) = v.hook.activeReserves();
        (bool buyWeth, uint256 grossIn) = _arbAmount(aW, aU, p8);
        if (vm.envOr("REPLAY_DEBUG", false) && v.lambda == 0.5e18) console.log("hook ", aW, aU, grossIn);
        if (grossIn == 0) return;
        BalanceDelta d = swapper.swap(v.key, SwapParams({ zeroForOne: !buyWeth, amountSpecified: -int256(grossIn), sqrtPriceLimitX96: buyWeth ? MAX_SQRT : MIN_SQRT }), PoolSwapTest.TestSettings(false, false), "");
        int256 dWeth = d.amount0(); int256 dUsdc = d.amount1();
        v.arbProfit += _value(uint256(dWeth > 0 ? dWeth : -dWeth), p8) * (dWeth > 0 ? int256(1) : int256(-1)) + dUsdc;
        v.trades++;
    }

    function _arbAqua(Venue storage v, uint256 p8) internal {
        bytes32 h = router.hash(v.order);
        (uint256 tW,) = AQUA.rawBalances(aquaMaker, address(router), h, WETH);
        (uint256 tU,) = AQUA.rawBalances(aquaMaker, address(router), h, USDC);
        (uint256 aW,) = IcebergMath.split(tW, v.lambda);
        (uint256 aU,) = IcebergMath.split(tU, v.lambda);
        (bool buyWeth, uint256 grossIn) = _arbAmount(aW, aU, p8);
        if (vm.envOr("REPLAY_DEBUG", false)) console.log("aqua ", aW, aU, grossIn);
        if (grossIn == 0) return;
        (uint256 aIn, uint256 aOut,) = taker.swap(v.order, grossIn, TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: true, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: !buyWeth, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        })));
        v.arbProfit += buyWeth ? _value(aOut, p8) - int256(aIn) : int256(aOut) - _value(aIn, p8);
        v.trades++;
    }

    // ------------------------------------------------------------------ the replay

    function test_replay_21Sep() public {
        uint256 minutes_ = vm.envOr("REPLAY_MINUTES", uint256(120));
        if (minutes_ > px.length) minutes_ = px.length;
        uint256 p0 = px[0];
        venues.push(_plainV4(p0));
        venues.push(_hook(p0, 1e18, 1));
        venues.push(_hook(p0, 0.5e18, 2));
        venues.push(_hook(p0, 0.39e18, 3));
        venues.push(_aqua(p0, 0.5e18));

        // benchmark: the same starting value, rebalanced to 50/50 at every minute's real price, costlessly
        uint256 bench = 2 * _usdcFor(2 ether, p0) * 1e12; // value in USDC * 1e12 for precision
        uint256 bn = block.number; uint256 ts = block.timestamp; // explicit counters: via-ir caches block.number across vm.roll
        for (uint256 i = 1; i < minutes_; i++) {
            bn += 1; ts += 60;
            vm.roll(bn); vm.warp(ts); // one block per minute: Algorithm 1 re-splits every step
            uint256 p8 = px[i];
            bench = bench * (px[i] + px[i - 1]) / (2 * px[i - 1]);
            for (uint256 j; j < venues.length; j++) {
                Venue storage v = venues[j];
                if (v.kind == 0) _arbPlain(v, p8); else if (v.kind == 1) _arbHook(v, p8); else _arbAqua(v, p8);
            }
        }

        uint256 pEnd = px[minutes_ - 1];
        int256 benchUsdc = int256(bench / 1e12);
        for (uint256 j; j < venues.length; j++) {
            Venue storage v = venues[j];
            int256 value;
            if (v.kind == 0) {
                uint256 w0 = IERC20(WETH).balanceOf(address(this)); uint256 u0 = IERC20(USDC).balanceOf(address(this));
                lpRouter.modifyLiquidity(v.key, ModifyLiquidityParams({ tickLower: -887205, tickUpper: 887205, liquidityDelta: -v.liq, salt: 0 }), "");
                value = _value(IERC20(WETH).balanceOf(address(this)) - w0, pEnd) + int256(IERC20(USDC).balanceOf(address(this)) - u0);
            } else if (v.kind == 1) {
                (uint256 rW, uint256 rU) = v.hook.reserves();
                value = _value(rW, pEnd) + int256(rU);
            } else {
                bytes32 hh = router.hash(v.order);
                (uint256 qW,) = AQUA.rawBalances(aquaMaker, address(router), hh, WETH);
                (uint256 qU,) = AQUA.rawBalances(aquaMaker, address(router), hh, USDC);
                value = _value(qW, pEnd) + int256(qU);
            }
            v.lpLoss = benchUsdc - value;
        }
        if (vm.envOr("REPLAY_DEBUG", false)) {
            (uint256 hW, uint256 hU) = venues[2].hook.reserves();
            bytes32 h = router.hash(venues[4].order);
            (uint256 qW,) = AQUA.rawBalances(aquaMaker, address(router), h, WETH);
            (uint256 qU,) = AQUA.rawBalances(aquaMaker, address(router), h, USDC);
            console.log("hook reserves  W/U", hW, hU);
            console.log("aqua balances  W/U", qW, qU);
        }
        int256 base = venues[0].lpLoss;
        string memory out = "replay";
        vm.serializeInt(out, "benchmarkValueUsdc6", benchUsdc);
        vm.serializeUint(out, "minutes", minutes_);
        vm.serializeUint(out, "startPrice8", p0);
        vm.serializeUint(out, "endPrice8", px[minutes_ - 1]);
        console.log("Replay of real ETH/USD, minutes:", minutes_);
        for (uint256 j; j < venues.length; j++) {
            Venue storage v = venues[j];
            string memory k = string.concat("venue", vm.toString(j));
            vm.serializeString(k, "name", v.name);
            vm.serializeUint(k, "lambdaWad", v.lambda);
            vm.serializeUint(k, "trades", v.trades);
            vm.serializeInt(k, "arbitrageProfitUsdc6", v.arbProfit);
            string memory row = vm.serializeInt(k, "lpLossVsRebalancedUsdc6", v.lpLoss);
            out = vm.serializeString("replay", k, row);
            int256 pct = base == 0 ? int256(0) : (base - v.lpLoss) * 10_000 / base;
            console.log(string.concat("  ", v.name, " | LP loss vs rebalanced (USDC 6dp): ", vm.toString(v.lpLoss), " | arb profit: ", vm.toString(v.arbProfit), " | trades: ", vm.toString(v.trades), " | loss saved vs plain v4 (bps): ", vm.toString(pct)));
        }
        if (vm.envOr("REPLAY_MINUTES", uint256(0)) != 0) vm.writeJson(out, string.concat("research/replay_2026-09-21_", vm.toString(minutes_), "min.json")); // only for explicit replays

        // sanity: Iceberg at lambda = 1 is the plain curve (within rounding of the v4 tick math)
        assertApproxEqRel(venues[1].lpLoss, venues[0].lpLoss, 0.05e18, "lambda = 1 hook must match the plain v4 pool");
        // the two venues of Iceberg agree (same kernel)
        assertApproxEqAbs(venues[2].lpLoss, venues[4].lpLoss, 10, "v4 hook and Aqua position must end with the same value at the same lambda");
    }
}
