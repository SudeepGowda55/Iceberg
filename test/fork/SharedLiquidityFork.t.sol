// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { IcebergParams } from "../../contracts/iceberg/IcebergParams.sol";
import { VaultedInventoryHooks } from "../../contracts/iceberg/VaultedInventoryHooks.sol";
import { IcebergConfig as C } from "../../contracts/periphery/IcebergConfig.sol";
import { SwapVM102 } from "../../contracts/periphery/SwapVM102.sol";

interface IRouter102 { function swap(ISwapVM.Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData) external returns (uint256, uint256, bytes32); }

/// @title The deployed configuration on a Base fork: the Iceberg position (with salt) and a plain strategy on 1inch's
///        real official router, both backed by the SAME Morpho vault shares (Aqua shared liquidity), plus the
///        retire / re-ship path the keeper's rebalance uses.
contract SharedLiquidityForkTest is Test {
    IcebergRouter router; IcebergParams params; VaultedInventoryHooks hooks; VaultedInventoryHooks officialHooks;
    address maker = makeAddr("maker"); address taker = makeAddr("taker");
    ISwapVM.Order order; ISwapVM.Order shared;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        router = new IcebergRouter(C.AQUA, C.WETH, address(this), "Iceberg", "1");
        params = new IcebergParams();
        hooks = new VaultedInventoryHooks(address(router));
        officialHooks = new VaultedInventoryHooks(C.OFFICIAL_ROUTER);
        order = C.order(maker, address(hooks), address(params), C.FEED_ETH_USD, 1);
        shared = C.sharedOrder(maker, address(officialHooks));
        (, int256 px,,,) = IFeed(C.FEED_ETH_USD).latestRoundData();
        uint256 w = 2 ether; uint256 u = w * uint256(px) / 1e20;
        deal(C.WETH, maker, w); deal(C.USDC, maker, u);
        vm.startPrank(maker);
        IERC20(C.WETH).approve(C.VAULT_WETH, w); IERC4626(C.VAULT_WETH).deposit(w, maker);
        IERC20(C.USDC).approve(C.VAULT_USDC, u); IERC4626(C.VAULT_USDC).deposit(u, maker);
        IERC20(C.WETH).approve(C.AQUA, type(uint256).max); IERC20(C.USDC).approve(C.AQUA, type(uint256).max);
        for (uint256 i; i < 2; i++) {
            address h = i == 0 ? address(hooks) : address(officialHooks);
            IERC20(C.VAULT_WETH).approve(h, type(uint256).max); IERC20(C.VAULT_USDC).approve(h, type(uint256).max);
            IERC20(C.WETH).approve(h, type(uint256).max); IERC20(C.USDC).approve(h, type(uint256).max);
        }
        params.setKeeper(maker, C.MIN_LAMBDA, 1e18);
        params.setVault(C.WETH, C.VAULT_WETH); params.setVault(C.USDC, C.VAULT_USDC);
        address[] memory t = new address[](2); t[0] = C.WETH; t[1] = C.USDC;
        uint256[] memory a = new uint256[](2); a[0] = w; a[1] = u;
        IAqua(C.AQUA).ship(address(router), abi.encode(order), t, a);
        uint256[] memory sa = new uint256[](2); sa[0] = w * C.SHARED_BPS / 10_000; sa[1] = u * C.SHARED_BPS / 10_000;
        IAqua(C.AQUA).ship(C.OFFICIAL_ROUTER, abi.encode(shared), t, sa);
        vm.stopPrank();
        deal(C.USDC, taker, 10_000e6); deal(C.WETH, taker, 5 ether);
        vm.startPrank(taker);
        IERC20(C.USDC).approve(address(router), type(uint256).max); IERC20(C.WETH).approve(address(router), type(uint256).max);
        IERC20(C.USDC).approve(C.OFFICIAL_ROUTER, type(uint256).max); IERC20(C.WETH).approve(C.OFFICIAL_ROUTER, type(uint256).max);
        vm.stopPrank();
    }

    function test_icebergPositionAndOfficialRouterStrategy_shareOneMorphoBalance() public {
        assertEq(IERC20(C.WETH).balanceOf(maker), 0, "maker holds only vault shares");
        vm.prank(taker);
        (, uint256 out1,) = ISwapVM(address(router)).swap(order, 100e6, C.takerData(taker, false));
        vm.roll(block.number + 1);
        vm.prank(taker);
        (, uint256 out2,) = IRouter102(C.OFFICIAL_ROUTER).swap(shared, C.USDC, C.WETH, 100e6, SwapVM102.EOA_TAKER_TRAITS);
        assertGt(out1, 0); assertGt(out2, 0);
        assertEq(IERC20(C.WETH).balanceOf(taker), 5 ether + out1 + out2, "both fills came out of the same Moonwell ETH vault shares");
        assertEq(IERC20(C.USDC).balanceOf(maker), 0, "both fills' proceeds swept back into Steakhouse USDC");
    }

    function test_rebalancePath_retireThenReshipWithNewSalt() public {
        bytes32 h1 = router.hash(order);
        address[] memory t = new address[](2); t[0] = C.WETH; t[1] = C.USDC;
        vm.startPrank(maker);
        IAqua(C.AQUA).dock(address(router), h1, t);
        // a docked strategy can never be shipped again: the keeper re-ships with salt + 1
        uint256[] memory a = new uint256[](2); a[0] = 1 ether; a[1] = 2_000e6;
        vm.expectRevert();
        IAqua(C.AQUA).ship(address(router), abi.encode(order), t, a);
        ISwapVM.Order memory next = C.order(maker, address(hooks), address(params), C.FEED_ETH_USD, 2);
        bytes32 h2 = IAqua(C.AQUA).ship(address(router), abi.encode(next), t, a);
        vm.stopPrank();
        assertTrue(h2 != h1, "new salt, new strategy");
        vm.prank(taker);
        (, uint256 out,) = ISwapVM(address(router)).swap(next, 50e6, C.takerData(taker, false));
        assertGt(out, 0, "fills continue on the re-shipped strategy");
    }
}

interface IFeed { function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80); }
