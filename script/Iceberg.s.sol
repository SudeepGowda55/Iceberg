// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { IcebergRouter } from "../contracts/iceberg/IcebergRouter.sol";
import { IcebergParams } from "../contracts/iceberg/IcebergParams.sol";
import { VaultedInventoryHooks } from "../contracts/iceberg/VaultedInventoryHooks.sol";
import { IcebergConfig as C } from "../contracts/periphery/IcebergConfig.sol";
import { IcebergLens } from "../contracts/periphery/IcebergLens.sol";
import { IcebergHook } from "../contracts/v4/IcebergHook.sol";
import { ILambdaSource } from "../contracts/iceberg/ILambdaSource.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import { BaseCustomAccounting } from "uniswap-hooks/src/base/BaseCustomAccounting.sol";

interface IFeed { function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80); }

/// @notice Deploys IcebergRouter (official Aqua router + Iceberg opcodes), VaultedInventoryHooks and IcebergParams
/// @dev env: PK
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PK");
        vm.startBroadcast(pk);
        IcebergRouter router = new IcebergRouter(C.AQUA, C.WETH, vm.addr(pk), "Iceberg", "1");
        VaultedInventoryHooks hooks = new VaultedInventoryHooks(address(router));
        IcebergParams params = new IcebergParams();
        VaultedInventoryHooks officialHooks = new VaultedInventoryHooks(C.OFFICIAL_ROUTER);
        vm.stopBroadcast();
        console.log("ROUTER", address(router));
        console.log("HOOKS", address(hooks));
        console.log("OFFICIAL_HOOKS", address(officialHooks));
        console.log("PARAMS", address(params));
    }
}

/// @notice Moves the maker's inventory into the Morpho vaults, sets every approval, registers the keeper, and ships
///         the partially active position on Aqua with virtual balances equal to the vaulted assets (balanced at Chainlink)
/// @dev env: PK, ROUTER, HOOKS, PARAMS, VAULT_WETH_AMOUNT (wei); keeps any other raw WETH/USDC in the wallet as taker float
contract Ship is Script {
    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        address router = vm.envAddress("ROUTER"); address hooks = vm.envAddress("HOOKS"); address params = vm.envAddress("PARAMS");
        uint256 wethIn = vm.envUint("VAULT_WETH_AMOUNT");
        (, int256 px,,,) = IFeed(vm.envOr("FEED", C.FEED_ETH_USD)).latestRoundData();
        uint256 usdcIn = wethIn * uint256(px) / 1e20; // USDC (6) worth the same as wethIn at Chainlink ETH/USD (8)

        vm.startBroadcast(pk);
        IERC20(C.WETH).approve(C.VAULT_WETH, wethIn); IERC4626(C.VAULT_WETH).deposit(wethIn, me);
        IERC20(C.USDC).approve(C.VAULT_USDC, usdcIn); IERC4626(C.VAULT_USDC).deposit(usdcIn, me);
        // the four maker approvals: Aqua on both tokens, hooks on both vault shares and on both tokens
        IERC20(C.WETH).approve(C.AQUA, type(uint256).max); IERC20(C.USDC).approve(C.AQUA, type(uint256).max);
        IERC20(C.VAULT_WETH).approve(hooks, type(uint256).max); IERC20(C.VAULT_USDC).approve(hooks, type(uint256).max);
        IERC20(C.WETH).approve(hooks, type(uint256).max); IERC20(C.USDC).approve(hooks, type(uint256).max);
        // the same wallet also trades as the taker: the router pulls the taker's input with transferFrom
        IERC20(C.WETH).approve(router, type(uint256).max); IERC20(C.USDC).approve(router, type(uint256).max);
        // the maker is its own keeper here; λ may move in [0.1, 1]
        IcebergParams(params).setKeeper(me, C.MIN_LAMBDA, C.HOOK_MAX_LAMBDA); // same λ ceiling as the v4 pool: both venues always run the same λ
        IcebergParams(params).setVault(C.WETH, C.VAULT_WETH); IcebergParams(params).setVault(C.USDC, C.VAULT_USDC); // deliverability cap
        ISwapVM.Order memory o = C.order(me, hooks, params, vm.envOr("FEED", C.FEED_ETH_USD), uint64(vm.envOr("SALT", uint256(1))));
        address[] memory t = new address[](2); t[0] = C.WETH; t[1] = C.USDC;
        uint256[] memory a = new uint256[](2); a[0] = wethIn; a[1] = usdcIn;
        bytes32 h = IAqua(C.AQUA).ship(router, abi.encode(o), t, a);
        address officialHooks = vm.envOr("OFFICIAL_HOOKS", address(0));
        bytes32 sh;
        if (officialHooks != address(0)) {
            // Aqua shared liquidity: the SAME vault shares also back a plain strategy on 1inch's official router
            IERC20(C.VAULT_WETH).approve(officialHooks, type(uint256).max); IERC20(C.VAULT_USDC).approve(officialHooks, type(uint256).max);
            IERC20(C.WETH).approve(officialHooks, type(uint256).max); IERC20(C.USDC).approve(officialHooks, type(uint256).max);
            IERC20(C.WETH).approve(C.OFFICIAL_ROUTER, type(uint256).max); IERC20(C.USDC).approve(C.OFFICIAL_ROUTER, type(uint256).max);
            uint256[] memory sa = new uint256[](2); sa[0] = wethIn * C.SHARED_BPS / 10_000; sa[1] = usdcIn * C.SHARED_BPS / 10_000;
            sh = IAqua(C.AQUA).ship(C.OFFICIAL_ROUTER, abi.encode(C.sharedOrder(me, officialHooks)), t, sa);
        }
        vm.stopBroadcast();
        console.log("ORDER_HASH");
        console.logBytes32(h);
        console.log("SHARED_ORDER_HASH");
        console.logBytes32(sh);
        console.log("SHIPPED_WETH", wethIn);
        console.log("SHIPPED_USDC", usdcIn);
    }
}

/// @notice Real fills against the shipped position from the same wallet, alternating buy / sell, with the keeper
///         publishing λ between rounds. Each call is its own transaction (and block), so every fill re-splits.
/// @dev env: PK, ROUTER, HOOKS, PARAMS, FILLS, FILL_CENTS (USDC per buy, in cents), LAMBDAS (comma list in wad, round-robin).
///      Each sell returns 95% of the WETH the previous buy received: forge simulates all fills in one block, but on-chain
///      every fill lands in its own block and re-splits, so real outputs differ slightly from the simulated ones.
contract Fill is Script {
    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        address router = vm.envAddress("ROUTER"); address hooks = vm.envAddress("HOOKS"); address params = vm.envAddress("PARAMS");
        uint256 fills = vm.envUint("FILLS");
        uint256 fillCents = vm.envUint("FILL_CENTS");
        uint256[] memory lambdas = vm.envUint("LAMBDAS", ",");
        ISwapVM.Order memory o = C.order(me, hooks, params, vm.envOr("FEED", C.FEED_ETH_USD), uint64(vm.envOr("SALT", uint256(1))));
        bytes32 h = ISwapVM(router).hash(o);
        uint256 lastWeth;

        vm.startBroadcast(pk);
        for (uint256 i; i < fills; i++) {
            if (i % 5 == 0) IcebergParams(params).setLambda(me, h, uint64(lambdas[(i / 5) % lambdas.length]), 0);
            bool sell = i % 2 == 1;
            uint256 amount = sell ? lastWeth * 95 / 100 : fillCents * 1e4;
            (uint256 aIn, uint256 aOut,) = ISwapVM(router).swap(o, amount, C.takerData(me, sell));
            if (!sell) lastWeth = aOut;
            console.log(sell ? "SELL" : "BUY", aIn, aOut);
        }
        vm.stopBroadcast();
    }
}

/// @notice Uniswap v4 venue: deploys IcebergHook at a mined flag-valid address through the real CREATE2 deployer,
///         initializes its WETH/USDC pool, adds liquidity, parks the idle share in Morpho, deploys a swap router
/// @dev env: PK, PARAMS, HOOK_WETH_AMOUNT (wei); optional FEED (price used to size the USDC side)
contract DeployHook is Script {
    using PoolIdLibrary for PoolKey;
    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        address params = vm.envAddress("PARAMS");
        uint256 weth = vm.envUint("HOOK_WETH_AMOUNT");
        (, int256 px,,,) = IFeed(vm.envOr("FEED", C.FEED_ETH_USD)).latestRoundData();
        uint256 usdc = weth * uint256(px) / 1e20;
        // HOOK_VARIANT (default 0) nudges the fallback λ by a few wei: a new CREATE2 address for a fresh pool on a chain where
        // the default hook already exists (re-funding after a full withdraw, whose locked minimum-liquidity dust skews the old pool)
        IcebergHook.Config memory c = IcebergHook.Config(me, C.HOOK_FEE_PIPS, C.FALLBACK_LAMBDA + uint64(vm.envOr("HOOK_VARIANT", uint256(0))), C.MIN_LAMBDA, C.HOOK_MAX_LAMBDA,
            ILambdaSource(params), IERC4626(C.VAULT_WETH), IERC4626(C.VAULT_USDC));
        bytes memory args = abi.encode(IPoolManager(C.POOL_MANAGER), c);
        (address hookAddr, bytes32 salt) = HookMiner.find(C.CREATE2_DEPLOYER, C.HOOK_FLAGS, type(IcebergHook).creationCode, args);

        vm.startBroadcast(pk);
        (bool ok,) = C.CREATE2_DEPLOYER.call(abi.encodePacked(salt, abi.encodePacked(type(IcebergHook).creationCode, args)));
        require(ok && hookAddr.code.length > 0, "hook deploy failed");
        IcebergHook hook = IcebergHook(hookAddr);
        PoolKey memory key = PoolKey(Currency.wrap(C.WETH), Currency.wrap(C.USDC), 0, 60, IHooks(hookAddr));
        IPoolManager(C.POOL_MANAGER).initialize(key, 79228162514264337593543950336);
        IERC20(C.WETH).approve(hookAddr, type(uint256).max); IERC20(C.USDC).approve(hookAddr, type(uint256).max);
        hook.addLiquidity(BaseCustomAccounting.AddLiquidityParams(weth, usdc, 0, 0, block.timestamp + 600, 0, 0, bytes32(0)));
        // park what can never become active (1 - maxλ) in Morpho, minus a small margin
        uint256 parkW = weth * (1e18 - C.HOOK_MAX_LAMBDA) / 1e18 * 99 / 100;
        uint256 parkU = usdc * (1e18 - C.HOOK_MAX_LAMBDA) / 1e18 * 99 / 100;
        if (parkW > 0) hook.park(0, parkW);
        if (parkU > 0) hook.park(1, parkU);
        hook.setKeeper(me); // registers the keeper in IcebergParams with this pool's [λmin, maxλ] box
        PoolSwapTest swapper = new PoolSwapTest(IPoolManager(C.POOL_MANAGER));
        IERC20(C.WETH).approve(address(swapper), type(uint256).max); IERC20(C.USDC).approve(address(swapper), type(uint256).max);
        vm.stopBroadcast();
        console.log("HOOK", hookAddr);
        console.log("POOL_ID");
        console.logBytes32(PoolId.unwrap(key.toId()));
        console.log("SWAPPER", address(swapper));
        console.log("HOOK_WETH", weth);
        console.log("HOOK_USDC", usdc);
    }
}

/// @notice Deploys IcebergLens (read-only helper for off-chain code)
contract DeployLens is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PK"));
        address lens = address(new IcebergLens());
        vm.stopBroadcast();
        console.log("LENS", lens);
    }
}

/// @notice Real swaps through the Iceberg Uniswap v4 pool from the same wallet, with the keeper publishing λ for the
///         pool every 5 swaps. Each sell returns 95% of what the previous buy received (each swap lands in its own block).
/// @dev env: PK, PARAMS, HOOK, SWAPPER, POOL_ID, FILLS, FILL_CENTS, LAMBDAS
contract FillHook is Script {
    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        IcebergParams params = IcebergParams(vm.envAddress("PARAMS"));
        PoolSwapTest swapper = PoolSwapTest(vm.envAddress("SWAPPER"));
        bytes32 poolId = vm.envBytes32("POOL_ID");
        PoolKey memory key = PoolKey(Currency.wrap(C.WETH), Currency.wrap(C.USDC), 0, 60, IHooks(vm.envAddress("HOOK")));
        uint256 fills = vm.envUint("FILLS");
        uint256 fillCents = vm.envUint("FILL_CENTS");
        uint256[] memory lambdas = vm.envUint("LAMBDAS", ",");
        uint256 lastWeth;
        vm.startBroadcast(pk);
        for (uint256 i; i < fills; i++) {
            if (i % 5 == 0) params.setLambda(me, poolId, uint64(lambdas[(i / 5) % lambdas.length]), 0);
            bool sell = i % 2 == 1;
            uint256 amount = sell ? lastWeth * 95 / 100 : fillCents * 1e4;
            uint256 wb = IERC20(C.WETH).balanceOf(me);
            swapper.swap(key, SwapParams({ zeroForOne: sell, amountSpecified: -int256(amount), sqrtPriceLimitX96: sell ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341) }),
                PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }), "");
            if (!sell) lastWeth = IERC20(C.WETH).balanceOf(me) - wb;
            console.log(sell ? "V4_SELL" : "V4_BUY", amount);
        }
        vm.stopBroadcast();
    }
}

/// @notice Re-fund the 1inch side of an existing deployment after a full withdraw: the same router and params, a new Aqua
///         strategy (next salt, since a docked strategy can never be shipped again) and fresh official-router hooks (the
///         shared order carries no salt, so new hooks give it a new hash). Expects the WETH already wrapped in the wallet.
/// @dev env: PK, ROUTER, HOOKS, PARAMS, SALT, AQUA_WETH, LAMBDA (wad). The v4 side re-deploys with DeployHook + HOOK_VARIANT.
/// @dev env: PK, ROUTER, HOOKS, PARAMS, HOOK, SALT, AQUA_WETH, HOOK_WETH, LAMBDA (wad)
contract Refund is Script {
    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        address router = vm.envAddress("ROUTER"); address hooks = vm.envAddress("HOOKS"); address params = vm.envAddress("PARAMS");
        uint256 aw = vm.envUint("AQUA_WETH");
        (, int256 px,,,) = IFeed(C.FEED_ETH_USD).latestRoundData();
        uint256 au = aw * uint256(px) / 1e20;

        vm.startBroadcast(pk);
        // 1inch venue: vault the inventory, ship the next-salt strategy, give it the keeper's λ
        IERC20(C.WETH).approve(C.VAULT_WETH, aw); IERC4626(C.VAULT_WETH).deposit(aw, me);
        IERC20(C.USDC).approve(C.VAULT_USDC, au); IERC4626(C.VAULT_USDC).deposit(au, me);
        ISwapVM.Order memory o = C.order(me, hooks, params, C.FEED_ETH_USD, uint64(vm.envUint("SALT")));
        address[] memory t = new address[](2); t[0] = C.WETH; t[1] = C.USDC;
        uint256[] memory a = new uint256[](2); a[0] = aw; a[1] = au;
        bytes32 h = IAqua(C.AQUA).ship(router, abi.encode(o), t, a);
        IcebergParams(params).setLambda(me, h, uint64(vm.envUint("LAMBDA")), 0);
        // Aqua shared liquidity on 1inch's official router, through fresh vault hooks
        VaultedInventoryHooks oh = new VaultedInventoryHooks(C.OFFICIAL_ROUTER);
        IERC20(C.VAULT_WETH).approve(address(oh), type(uint256).max); IERC20(C.VAULT_USDC).approve(address(oh), type(uint256).max);
        IERC20(C.WETH).approve(address(oh), type(uint256).max); IERC20(C.USDC).approve(address(oh), type(uint256).max);
        uint256[] memory sa = new uint256[](2); sa[0] = aw * C.SHARED_BPS / 10_000; sa[1] = au * C.SHARED_BPS / 10_000;
        bytes32 sh = IAqua(C.AQUA).ship(C.OFFICIAL_ROUTER, abi.encode(C.sharedOrder(me, address(oh))), t, sa);
        vm.stopBroadcast();
        console.log("ORDER_HASH");
        console.logBytes32(h);
        console.log("SHARED_ORDER_HASH");
        console.logBytes32(sh);
        console.log("OFFICIAL_HOOKS", address(oh));
    }
}
