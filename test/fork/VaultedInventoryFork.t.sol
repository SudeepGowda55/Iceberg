// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { Deadline } from "@1inch/swap-vm/instructions/Controls.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { UniV4PegSwap } from "../../contracts/iceberg/UniV4PegSwap.sol";
import { VaultedInventoryHooks } from "../../contracts/iceberg/VaultedInventoryHooks.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";

interface IStateView { function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24); }

contract ForkTaker2 is ITakerCallbacks {
    IAqua immutable AQUA; address immutable ROUTER;
    constructor(IAqua a, address r) { AQUA = a; ROUTER = r; }
    function swap(ISwapVM.Order calldata o, uint256 amount, bytes calldata td) external returns (uint256, uint256, bytes32) { return ISwapVM(ROUTER).swap(o, amount, td); }
    function preTransferInCallback(address maker, address, address tokenIn, address, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata) external {
        require(msg.sender == ROUTER); IERC20(tokenIn).approve(address(AQUA), amountIn); AQUA.push(maker, ROUTER, orderHash, tokenIn, amountIn);
    }
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata) external {}
}

/// @title Vaulted inventory on a Base mainnet fork: maker holds ONLY Morpho vault shares, quotes at Uniswap v4 spot
contract VaultedInventoryForkTest is Test {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    IStateView constant STATE_VIEW = IStateView(0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 constant POOL_ID = 0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a;
    IERC4626 constant VAULT_WETH = IERC4626(0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1); // Moonwell Flagship ETH (Morpho)
    IERC4626 constant VAULT_USDC = IERC4626(0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183); // Steakhouse USDC (Morpho)
    uint24 constant SPREAD_BPS = 8;

    IcebergRouter router; VaultedInventoryHooks hooks; ForkTaker2 taker;
    address maker = makeAddr("maker");
    ISwapVM.Order order; bytes32 strategyHash;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "0.1");
        hooks = new VaultedInventoryHooks(address(router));
        taker = new ForkTaker2(AQUA, address(router));

        // Maker deposits everything into real Morpho vaults; wallet ends with ZERO raw WETH/USDC
        deal(WETH, maker, 2 ether); deal(USDC, maker, 5_000e6);
        vm.startPrank(maker);
        IERC20(WETH).approve(address(VAULT_WETH), 2 ether); VAULT_WETH.deposit(2 ether, maker);
        IERC20(USDC).approve(address(VAULT_USDC), 5_000e6); VAULT_USDC.deposit(5_000e6, maker);
        // Approvals: Aqua pulls raw tokens; hooks may withdraw vault shares and sweep raw tokens back into vaults
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        IERC20(address(VAULT_WETH)).approve(address(hooks), type(uint256).max); IERC20(address(VAULT_USDC)).approve(address(hooks), type(uint256).max);
        IERC20(WETH).approve(address(hooks), type(uint256).max); IERC20(USDC).approve(address(hooks), type(uint256).max);
        vm.stopPrank();
        assertEq(IERC20(WETH).balanceOf(maker), 0); assertEq(IERC20(USDC).balanceOf(maker), 0);

        bytes memory vaults = abi.encode(address(VAULT_WETH), address(VAULT_USDC)); // ordered by token address: WETH < USDC
        order = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC,
            shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false, receiver: address(0),
            hasPreTransferInHook: false, hasPostTransferInHook: true, hasPreTransferOutHook: true, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "",
            postTransferInTarget: address(hooks), postTransferInData: vaults,
            preTransferOutTarget: address(hooks), preTransferOutData: vaults,
            postTransferOutTarget: address(0), postTransferOutData: "",
            program: bytes.concat(Deadline.build(uint40(block.timestamp + 1 days)), UniV4PegSwap.build(POOL_MANAGER, POOL_ID, USDC, SPREAD_BPS))
        }));
        address[] memory tokens = new address[](2); tokens[0] = WETH; tokens[1] = USDC;
        uint256[] memory amounts = new uint256[](2); amounts[0] = 2 ether; amounts[1] = 5_000e6;
        vm.prank(maker);
        strategyHash = AQUA.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function _td(bool isExactIn, bool isAToB) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: isExactIn, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: isAToB, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "", preTransferOutHookData: "",
            postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "", instructionsArgs: "", signature: ""
        }));
    }

    function test_Fork_FillFromVaultedInventory_BuyWeth() public {
        uint256 amountIn = 1_000e6; deal(USDC, address(taker), amountIn);
        uint256 wethVaultBefore = VAULT_WETH.maxWithdraw(maker); uint256 usdcVaultBefore = VAULT_USDC.maxWithdraw(maker);

        (, uint256 aOut,) = taker.swap(order, amountIn, _td(true, false));

        // Taker got WETH priced at v4 spot + spread; maker wallet still holds no raw tokens
        assertEq(IERC20(WETH).balanceOf(address(taker)), aOut);
        assertEq(IERC20(WETH).balanceOf(maker), 0, "raw WETH left in wallet");
        assertEq(IERC20(USDC).balanceOf(maker), 0, "raw USDC left in wallet");
        // Vault positions moved by exactly the fill (1 wei tolerance for ERC-4626 rounding)
        assertApproxEqAbs(VAULT_WETH.maxWithdraw(maker), wethVaultBefore - aOut, 2, "WETH vault not drawn by fill");
        assertApproxEqAbs(VAULT_USDC.maxWithdraw(maker), usdcVaultBefore + amountIn, 2, "USDC not swept into vault");
        // Aqua virtual balances track the vaulted inventory
        (uint256 bWeth, uint256 bUsdc) = AQUA.safeBalances(maker, address(router), strategyHash, WETH, USDC);
        assertEq(bWeth, 2 ether - aOut); assertEq(bUsdc, 5_000e6 + amountIn);
        (uint160 sqrtP,,,) = STATE_VIEW.getSlot0(POOL_ID);
        emit log_named_decimal_uint("v4 sqrtPriceX96-derived USD/ETH", ((uint256(sqrtP) * uint256(sqrtP)) >> 96) * 1e12 * 1e18 >> 96, 18);
        emit log_named_decimal_uint("taker paid USD/ETH", amountIn * 1e12 * 1e18 / aOut, 18);
        emit log_named_decimal_uint("WETH unvaulted for fill", aOut, 18);
    }

    function test_Fork_FillFromVaultedInventory_SellWeth() public {
        deal(WETH, address(taker), 1 ether);
        uint256 usdcVaultBefore = VAULT_USDC.maxWithdraw(maker);
        (uint256 aIn, uint256 aOut,) = taker.swap(order, 0.25 ether, _td(true, true));
        assertEq(IERC20(USDC).balanceOf(address(taker)), aOut);
        assertEq(IERC20(WETH).balanceOf(maker), 0); assertEq(IERC20(USDC).balanceOf(maker), 0);
        assertApproxEqAbs(VAULT_USDC.maxWithdraw(maker), usdcVaultBefore - aOut, 2);
        assertApproxEqAbs(VAULT_WETH.maxWithdraw(maker), 2 ether + aIn, 2);
    }

    function test_Fork_HookRejectsNonRouterCaller() public {
        vm.expectRevert(abi.encodeWithSelector(VaultedInventoryHooks.OnlyRouter.selector, address(this)));
        hooks.preTransferOut(maker, address(0), USDC, WETH, 0, 1 ether, bytes32(0), abi.encode(address(VAULT_WETH), address(VAULT_USDC)), "");
    }
}
