// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { Deadline } from "@1inch/swap-vm/instructions/Controls.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { UniV4PegSwap } from "../../contracts/iceberg/UniV4PegSwap.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";

interface IStateView { function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24); }

/// @dev Minimal taker that pushes tokenIn into Aqua during the pre-transfer-in callback (same as 1inch's MockTaker)
contract ForkTaker is ITakerCallbacks {
    IAqua immutable AQUA; address immutable ROUTER;
    constructor(IAqua a, address r) { AQUA = a; ROUTER = r; }
    function swap(ISwapVM.Order calldata o, uint256 amount, bytes calldata td) external returns (uint256, uint256, bytes32) {
        return ISwapVM(ROUTER).swap(o, amount, td);
    }
    function preTransferInCallback(address maker, address, address tokenIn, address, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata) external {
        require(msg.sender == ROUTER);
        IERC20(tokenIn).approve(address(AQUA), amountIn);
        AQUA.push(maker, ROUTER, orderHash, tokenIn, amountIn);
    }
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata) external {}
}

/// @title Iceberg on a Base mainnet fork: real Aqua, real USDC/WETH, real Uniswap v4 PoolManager state
contract UniV4PegForkTest is Test {
    // Real Base mainnet addresses
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    IStateView constant STATE_VIEW = IStateView(0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    // Uniswap v4 native-ETH/USDC 0.05% pool (tickSpacing 10, no hook)
    bytes32 constant POOL_ID = 0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a;
    uint24 constant SPREAD_BPS = 8;

    IcebergRouter router;
    ForkTaker taker;
    address maker = makeAddr("maker");
    ISwapVM.Order order;
    bytes32 strategyHash;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        assertGt(address(AQUA).code.length, 0, "Aqua not deployed at expected address");
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager not deployed");

        router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "0.1");
        taker = new ForkTaker(AQUA, address(router));

        bytes memory program = bytes.concat(
            Deadline.build(uint40(block.timestamp + 1 days)),
            UniV4PegSwap.build(POOL_MANAGER, POOL_ID, USDC, SPREAD_BPS)
        );
        order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC, // WETH (0x4200..) < USDC (0x8335..) by address
            shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false,
            receiver: address(0),
            hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "",
            program: program
        }));

        // Maker keeps funds in wallet, only approves Aqua, ships 2 WETH + 5000 USDC virtual balances
        deal(WETH, maker, 2 ether);
        deal(USDC, maker, 5_000e6);
        vm.startPrank(maker);
        IERC20(WETH).approve(address(AQUA), type(uint256).max);
        IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory tokens = new address[](2); tokens[0] = WETH; tokens[1] = USDC;
        uint256[] memory amounts = new uint256[](2); amounts[0] = 2 ether; amounts[1] = 5_000e6;
        strategyHash = AQUA.ship(address(router), abi.encode(order), tokens, amounts);
        vm.stopPrank();
        assertEq(strategyHash, router.hash(order), "strategy hash must equal order hash");
    }

    function _takerData(bool isExactIn, bool isAToB) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: isExactIn, shouldUnwrapWeth: false,
            hasPreTransferInCallback: true, hasPreTransferOutCallback: false, isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: isAToB, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0,
            preTransferInHookData: "", postTransferInHookData: "", preTransferOutHookData: "", postTransferOutHookData: "",
            preTransferInCallbackData: "", preTransferOutCallbackData: "", instructionsArgs: "", signature: ""
        }));
    }

    function _v4PriceUsdPerEth() internal view returns (uint256 price1e18) {
        (uint160 sqrtP,,,) = STATE_VIEW.getSlot0(POOL_ID);
        // USDC(6) per ETH(18): (sqrtP/2^96)^2 * 1e12, scaled to 1e18
        uint256 p = (uint256(sqrtP) * uint256(sqrtP)) >> 96; // Q96
        price1e18 = p * 1e12 * 1e18 >> 96;
    }

    function test_Fork_BuyWethWithUsdc_AtUniswapV4SpotMinusSpread() public {
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(taker), amountIn);
        uint256 makerWethBefore = IERC20(WETH).balanceOf(maker);
        uint256 makerUsdcBefore = IERC20(USDC).balanceOf(maker);

        (uint256 qIn, uint256 qOut,) = router.asView().quote(order, amountIn, _takerData(true, false));
        (uint256 aIn, uint256 aOut,) = taker.swap(order, amountIn, _takerData(true, false));
        assertEq(aIn, qIn, "quote/swap in mismatch"); assertEq(aOut, qOut, "quote/swap out mismatch");

        // Real token movement: taker paid USDC into maker's wallet, maker's WETH went to taker
        assertEq(IERC20(USDC).balanceOf(maker), makerUsdcBefore + amountIn, "maker did not receive USDC");
        assertEq(IERC20(WETH).balanceOf(maker), makerWethBefore - aOut, "maker WETH not pulled");
        assertEq(IERC20(WETH).balanceOf(address(taker)), aOut, "taker did not receive WETH");

        // Effective price must be v4 spot marked up by exactly the spread (within rounding)
        uint256 v4 = _v4PriceUsdPerEth();
        uint256 paidUsdPerEth = amountIn * 1e12 * 1e18 / aOut;
        uint256 expected = v4 * 10_000 / (10_000 - SPREAD_BPS);
        assertApproxEqRel(paidUsdPerEth, expected, 1e12, "price not pegged to v4 spot + spread");
        emit log_named_decimal_uint("v4 spot USD/ETH", v4, 18);
        emit log_named_decimal_uint("taker paid USD/ETH", paidUsdPerEth, 18);
        emit log_named_decimal_uint("WETH received", aOut, 18);
    }

    function test_Fork_SellWethForUsdc_ExactOut() public {
        uint256 wantUsdc = 500e6;
        deal(WETH, address(taker), 1 ether);
        (uint256 aIn, uint256 aOut,) = taker.swap(order, wantUsdc, _takerData(false, true));
        assertEq(aOut, wantUsdc, "exact out not honored");
        uint256 v4 = _v4PriceUsdPerEth();
        uint256 receivedUsdPerEth = aOut * 1e12 * 1e18 / aIn;
        uint256 expected = v4 * (10_000 - SPREAD_BPS) / 10_000;
        assertApproxEqRel(receivedUsdPerEth, expected, 1e12, "sell price not pegged");
        assertEq(IERC20(USDC).balanceOf(address(taker)), wantUsdc, "taker did not get USDC");
        emit log_named_decimal_uint("WETH paid for 500 USDC", aIn, 18);
    }

    function test_Fork_RevertsWhenFillExceedsMakerInventory() public {
        uint256 amountIn = 100_000e6; // would need ~37 WETH, maker shipped 2
        deal(USDC, address(taker), amountIn);
        vm.expectRevert();
        taker.swap(order, amountIn, _takerData(true, false));
    }
}
