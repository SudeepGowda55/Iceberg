// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { SwapParams, ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import { BaseCustomAccounting } from "uniswap-hooks/src/base/BaseCustomAccounting.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/instructions/FeeFlat.sol";
import { IcebergHook } from "../../contracts/v4/IcebergHook.sol";
import { IcebergMath } from "../../contracts/iceberg/IcebergMath.sol";
import { IcebergParams } from "../../contracts/iceberg/IcebergParams.sol";
import { ILambdaSource } from "../../contracts/iceberg/ILambdaSource.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { PAActiveReserves } from "../../contracts/iceberg/PAActiveReserves.sol";

contract AquaTaker is ITakerCallbacks {
    IAqua immutable AQUA; address immutable ROUTER;
    constructor(IAqua a, address r) { AQUA = a; ROUTER = r; }
    function swap(ISwapVM.Order calldata o, uint256 amount, bytes calldata td) external returns (uint256, uint256, bytes32) { return ISwapVM(ROUTER).swap(o, amount, td); }
    function preTransferInCallback(address maker, address, address tokenIn, address, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata) external {
        IERC20(tokenIn).approve(address(AQUA), amountIn); AQUA.push(maker, ROUTER, orderHash, tokenIn, amountIn);
    }
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata) external {}
}

/// @title IcebergHook on a Base mainnet fork: real Uniswap v4 PoolManager, real WETH/USDC, real Morpho vaults
contract IcebergHookForkTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    IERC4626 constant VAULT_WETH = IERC4626(0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1);
    IERC4626 constant VAULT_USDC = IERC4626(0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183);
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
    uint24 constant FEE_PIPS = 500; // 5 bps

    PoolSwapTest swapper;
    IcebergParams params;
    address lp = makeAddr("lp");
    address trader = makeAddr("trader");
    uint256 salt;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        swapper = new PoolSwapTest(PM);
        params = new IcebergParams();
        deal(WETH, trader, 100 ether); deal(USDC, trader, 1_000_000e6);
        vm.startPrank(trader); IERC20(WETH).approve(address(swapper), type(uint256).max); IERC20(USDC).approve(address(swapper), type(uint256).max); vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _deploy(uint64 fallbackLambda, ILambdaSource source, uint64 maxLambda) internal returns (IcebergHook hook, PoolKey memory key) {
        address at = address(FLAGS | (uint160(++salt) << 144));
        IcebergHook.Config memory c = IcebergHook.Config(address(this), FEE_PIPS, fallbackLambda, 0.1e18, maxLambda, source, VAULT_WETH, VAULT_USDC);
        deployCodeTo("IcebergHook.sol:IcebergHook", abi.encode(PM, c), at);
        hook = IcebergHook(at);
        key = PoolKey(Currency.wrap(WETH), Currency.wrap(USDC), 0, 60, IHooks(at));
        PM.initialize(key, 79228162514264337593543950336);
        _add(hook, 2 ether, 5_400e6);
    }

    function _add(IcebergHook hook, uint256 a0, uint256 a1) internal {
        deal(WETH, lp, a0); deal(USDC, lp, a1);
        vm.startPrank(lp);
        IERC20(WETH).approve(address(hook), type(uint256).max); IERC20(USDC).approve(address(hook), type(uint256).max);
        hook.addLiquidity(BaseCustomAccounting.AddLiquidityParams(a0, a1, 0, 0, block.timestamp, 0, 0, bytes32(0)));
        vm.stopPrank();
    }

    /// @dev exact-in swap through the real PoolManager; returns the output amount
    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256 out) {
        address tOut = zeroForOne ? USDC : WETH;
        uint256 b = IERC20(tOut).balanceOf(trader);
        vm.prank(trader);
        swapper.swap(key, SwapParams({ zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341) }), PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }), "");
        out = IERC20(tOut).balanceOf(trader) - b;
    }

    // ------------------------------------------------------------------ tests

    function test_lambdaOne_isPlainConstantProductWithFee() public {
        (, PoolKey memory key) = _deploy(1e18, ILambdaSource(address(0)), 1e18);
        uint256 out = _swap(key, false, 500e6); // buy WETH with 500 USDC
        assertEq(out, IcebergMath.xycOut(5_400e6, 2 ether, 500e6, FEE_PIPS), "lambda = 1 prices on the full reserves");
    }

    function test_firstAndSecondSwapInBlock_usePassiveFixedAtBlockStart() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        uint256 out1 = _swap(key, false, 500e6);
        assertEq(out1, IcebergMath.xycOut(2_700e6, 1 ether, 500e6, FEE_PIPS), "first swap sees only the active half");
        assertEq(hook.splitBlock(), block.number);
        assertEq(hook.passive0(), 1 ether); assertEq(hook.passive1(), 2_700e6);
        (uint256 r0, uint256 r1) = hook.reserves();
        uint256 out2 = _swap(key, false, 300e6);
        assertEq(hook.passive0(), 1 ether, "passive WETH frozen inside the block"); assertEq(hook.passive1(), 2_700e6);
        assertEq(out2, IcebergMath.xycOut(r1 - 2_700e6, r0 - 1 ether, 300e6, FEE_PIPS), "second swap on (total - frozen passive)");
    }

    function test_nextBlock_resplits() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        _swap(key, false, 500e6);
        vm.roll(block.number + 1);
        (uint256 r0,) = hook.reserves();
        _swap(key, false, 100e6);
        assertEq(hook.splitBlock(), block.number);
        assertEq(hook.passive0(), r0 - r0 / 2, "passive recomputed from the new total");
    }

    function test_passiveCanNeverBeTraded() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.25e18, ILambdaSource(address(0)), 1e18);
        uint256 out = _swap(key, false, 500_000e6);
        assertLt(out, 0.5 ether, "a huge buy only reaches the active quarter");
        (uint256 r0,) = hook.reserves();
        assertGe(r0, 1.5 ether, "passive WETH untouched");
        // exact-out beyond the active side reverts
        vm.prank(trader);
        vm.expectRevert();
        swapper.swap(key, SwapParams({ zeroForOne: false, amountSpecified: int256(0.6 ether), sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970341 }), PoolSwapTest.TestSettings(false, false), "");
    }

    function test_exactOutput_paysAtLeastTheCurvePrice() public {
        (, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        uint256 usdcBefore = IERC20(USDC).balanceOf(trader);
        vm.prank(trader);
        swapper.swap(key, SwapParams({ zeroForOne: false, amountSpecified: int256(0.1 ether), sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970341 }), PoolSwapTest.TestSettings(false, false), "");
        uint256 paid = usdcBefore - IERC20(USDC).balanceOf(trader);
        // buying that much WETH back with `paid` exact-in on the same curve must not yield more than 0.1 WETH
        assertLe(IcebergMath.xycOut(2_700e6, 1 ether, paid, FEE_PIPS), 0.1 ether + 1, "exact-out never undercharges");
    }

    function test_keeperSource_setsLambda() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.8e18, ILambdaSource(address(params)), 1e18);
        hook.setKeeper(address(this));
        params.setLambda(address(hook), PoolId.unwrap(key.toId()), 0.3e18, 0);
        vm.expectRevert(); // the hook registered maxλ = 1e18 here; a λ below its floor (0.1) is refused
        params.setLambda(address(hook), PoolId.unwrap(key.toId()), 0.05e18, 0);
        _swap(key, false, 100e6);
        assertEq(hook.lastLambdaWad(), 0.3e18, "keeper lambda applied to the v4 pool");
        (uint256 act,) = IcebergMath.split(2 ether, 0.3e18);
        assertEq(hook.passive0(), 2 ether - act);
    }

    function test_directLiquidityThroughPoolManagerIsBlocked() public {
        (, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        PoolModifyLiquidityTest m = new PoolModifyLiquidityTest(PM);
        vm.expectRevert();
        m.modifyLiquidity(key, ModifyLiquidityParams({ tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0 }), "");
    }

    function test_parkIdleReservesInMorpho_thenSwap_thenUnparkAndWithdraw() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 0.6e18);
        // maxλ = 0.6: at most 40% of each reserve may be parked
        vm.expectRevert();
        hook.park(1, 2_500e6);
        hook.park(1, 2_000e6); // 37% of USDC into Steakhouse USDC
        hook.park(0, 0.8 ether); // 40% of WETH into Moonwell ETH
        (uint256 c0, uint256 c1) = hook.claims();
        (uint256 r0, uint256 r1) = hook.reserves();
        assertEq(c0, 1.2 ether); assertEq(c1, 3_400e6);
        assertApproxEqAbs(r0, 2 ether, 2, "parked WETH still counted in reserves");
        assertApproxEqAbs(r1, 5_400e6, 2, "parked USDC still counted in reserves");
        uint256 out = _swap(key, false, 500e6); // active half is fully inside the pool
        assertGt(out, 0);
        vm.warp(block.timestamp + 30 days); vm.roll(block.number + 1);
        (r0, r1) = hook.reserves();
        hook.unpark(0, type(uint256).max); hook.unpark(1, type(uint256).max);
        (c0, c1) = hook.claims();
        assertEq(hook.parkedShares0(), 0); assertEq(hook.parkedShares1(), 0);
        assertApproxEqAbs(c0, r0, 2, "all WETH back in the pool, including vault yield");
        assertApproxEqAbs(c1, r1, 2, "all USDC back in the pool, including vault yield");
        uint256 shares = hook.balanceOf(lp);
        vm.prank(lp);
        hook.removeLiquidity(BaseCustomAccounting.RemoveLiquidityParams(shares, 0, 0, block.timestamp, 0, 0, bytes32(0)));
        assertGe(IERC20(USDC).balanceOf(lp), 5_400e6 + 500e6 - 1, "LP gets principal, trader's payment and vault yield back");
    }

    function test_swapBeyondInPoolClaims_unparksFromMorphoInsideTheSwap() public {
        // fallback λ = 100% but max λ = 60%: 40% parked, so the active side reaches past what sits in the pool
        (IcebergHook hook, PoolKey memory key) = _deploy(1e18, ILambdaSource(address(0)), 0.6e18);
        hook.park(0, 0.8 ether);
        (uint256 c0,) = hook.claims();
        assertEq(c0, 1.2 ether);
        (uint256 a0,,) = hook.activeReserves();
        assertApproxEqAbs(a0, 2 ether, 2, "active side counts what the vault can release");
        uint256 shares0 = hook.parkedShares0();
        uint256 out = _swap(key, false, 12_000e6); // ~1.38 WETH out: more than the 1.2 WETH in the pool
        assertGt(out, 1.2 ether, "output beyond in-pool claims was delivered");
        assertLt(hook.parkedShares0(), shares0, "the shortfall came out of Morpho inside the swap");
    }

    function test_lpExitsWhileReservesAreParked_hookPullsFromMorpho() public {
        (IcebergHook hook, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 0.6e18);
        hook.park(0, 0.79 ether); hook.park(1, 2_100e6);
        _swap(key, false, 200e6);
        uint256 shares = hook.balanceOf(lp);
        assertEq(hook.balanceOf(address(0xdead)), hook.MINIMUM_LIQUIDITY(), "first deposit locked the minimum liquidity");
        uint256 w0 = IERC20(WETH).balanceOf(lp); uint256 u0 = IERC20(USDC).balanceOf(lp);
        vm.prank(lp);
        hook.removeLiquidity(BaseCustomAccounting.RemoveLiquidityParams(shares, 0, 0, block.timestamp, 0, 0, bytes32(0)));
        assertGt(IERC20(WETH).balanceOf(lp) - w0, 1.9 ether, "LP got its WETH back, parked part included");
        assertGt(IERC20(USDC).balanceOf(lp) - u0, 5_500e6, "LP got its USDC back, parked part and trader's payment included");
        assertLt(hook.parkedShares0() + hook.parkedShares1(), 1e15, "the exit pulled the parked reserves out of Morpho without an operator (dust = the locked minimum-liquidity share)");
    }

    function test_firstDeposit_tooSmallToCoverMinimumLiquidityReverts() public {
        address at = address(FLAGS | (uint160(0x77) << 144));
        IcebergHook.Config memory c = IcebergHook.Config(address(this), FEE_PIPS, 0.5e18, 0.1e18, 1e18, ILambdaSource(address(0)), VAULT_WETH, VAULT_USDC);
        deployCodeTo("IcebergHook.sol:IcebergHook", abi.encode(PM, c), at);
        PM.initialize(PoolKey(Currency.wrap(WETH), Currency.wrap(USDC), 0, 60, IHooks(at)), 79228162514264337593543950336);
        deal(WETH, lp, 1000); deal(USDC, lp, 1000);
        vm.startPrank(lp);
        IERC20(WETH).approve(at, type(uint256).max); IERC20(USDC).approve(at, type(uint256).max);
        vm.expectRevert();
        IcebergHook(at).addLiquidity(BaseCustomAccounting.AddLiquidityParams(1000, 1000, 0, 0, block.timestamp, 0, 0, bytes32(0)));
        vm.stopPrank();
    }

    function test_parityWithAquaVenue_sameReservesSamePrice() public {
        // Uniswap v4 venue
        (, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        uint256 outV4 = _swap(key, false, 500e6);
        // 1inch Aqua venue: same reserves, λ = 0.5, same 5 bps fee on input, stock XYCSwap
        IcebergRouter router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "1");
        AquaTaker taker = new AquaTaker(AQUA, address(router));
        address maker = makeAddr("aquaMaker");
        bytes memory program = bytes.concat(PAActiveReserves.fixedLambda(0.5e18), FeeFlatIn.build(0.0005e7), XYCSwap.build());
        ISwapVM.Order memory o = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false,
            receiver: address(0), hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "", program: program
        }));
        deal(WETH, maker, 2 ether); deal(USDC, maker, 5_400e6);
        vm.startPrank(maker);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory a = new uint256[](2); a[0] = 2 ether; a[1] = 5_400e6;
        AQUA.ship(address(router), abi.encode(o), t, a);
        vm.stopPrank();
        deal(USDC, address(taker), 500e6);
        (, uint256 outAqua,) = taker.swap(o, 500e6, TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: true, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: false, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        })));
        emit log_named_uint("WETH out, Uniswap v4 hook", outV4);
        emit log_named_uint("WETH out, 1inch Aqua instruction", outAqua);
        assertApproxEqAbs(outV4, outAqua, 1e9, "one kernel, two venues: same price within 1 gwei of WETH");
    }

    function _aquaVenue(uint64 lambda) internal returns (IcebergRouter router, AquaTaker taker, ISwapVM.Order memory o) {
        router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "1");
        taker = new AquaTaker(AQUA, address(router));
        address maker = makeAddr("seqMaker");
        o = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false,
            receiver: address(0), hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "",
            program: bytes.concat(PAActiveReserves.fixedLambda(lambda), FeeFlatIn.build(0.0005e7), XYCSwap.build())
        }));
        deal(WETH, maker, 2 ether); deal(USDC, maker, 5_400e6);
        vm.startPrank(maker);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory a = new uint256[](2); a[0] = 2 ether; a[1] = 5_400e6;
        AQUA.ship(address(router), abi.encode(o), t, a);
        vm.stopPrank();
        deal(WETH, address(taker), 100 ether); deal(USDC, address(taker), 1_000_000e6);
    }

    function _aquaSwap(AquaTaker taker, ISwapVM.Order memory o, bool sellWeth, uint256 amountIn) internal returns (uint256 out) {
        (, out,) = taker.swap(o, amountIn, TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: true, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: sellWeth, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        })));
    }

    function test_parity_sequenceOfBuysAndSells_acrossBlocks() public {
        (, PoolKey memory key) = _deploy(0.5e18, ILambdaSource(address(0)), 1e18);
        (,AquaTaker taker, ISwapVM.Order memory o) = _aquaVenue(0.5e18);
        uint256[6] memory amts = [uint256(300e6), 0.05 ether, 800e6, 0.2 ether, 50e6, 0.01 ether];
        for (uint256 i; i < 6; i++) {
            if (i % 2 == 1) vm.roll(block.number + 1);
            bool sell = i % 2 == 1;
            uint256 v4 = _swap(key, sell, amts[i]);
            uint256 aq = _aquaSwap(taker, o, sell, amts[i]);
            emit log_named_uint(string.concat(sell ? "sell " : "buy  ", vm.toString(i), " v4  "), v4);
            emit log_named_uint(string.concat(sell ? "sell " : "buy  ", vm.toString(i), " aqua"), aq);
            assertApproxEqAbs(v4, aq, sell ? 1 : 1e9, "venues diverge");
        }
    }

    function test_realCreate2Deployment_minedAddress() public {
        IcebergHook.Config memory c = IcebergHook.Config(address(this), FEE_PIPS, 0.5e18, 0.1e18, 1e18, ILambdaSource(address(0)), VAULT_WETH, VAULT_USDC);
        bytes memory args = abi.encode(PM, c);
        (address predicted, bytes32 s) = HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(IcebergHook).creationCode, args);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(s, abi.encodePacked(type(IcebergHook).creationCode, args)));
        assertTrue(ok && predicted.code.length > 0, "deployed through the real CREATE2 deployer at a flag-valid address");
        PoolKey memory key = PoolKey(Currency.wrap(WETH), Currency.wrap(USDC), 0, 60, IHooks(predicted));
        PM.initialize(key, 79228162514264337593543950336);
        _add(IcebergHook(predicted), 1 ether, 2_700e6);
        assertGt(_swap(key, false, 100e6), 0);
    }
}
