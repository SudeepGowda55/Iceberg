// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/instructions/FeeFlat.sol";
import { Salt } from "@1inch/swap-vm/instructions/Controls.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import { BaseCustomAccounting } from "uniswap-hooks/src/base/BaseCustomAccounting.sol";
import { IcebergRouter } from "../contracts/iceberg/IcebergRouter.sol";
import { IcebergParams } from "../contracts/iceberg/IcebergParams.sol";
import { PAActiveReserves } from "../contracts/iceberg/PAActiveReserves.sol";
import { ILambdaSource } from "../contracts/iceberg/ILambdaSource.sol";
import { IcebergHook } from "../contracts/v4/IcebergHook.sol";

interface IWETH { function deposit() external payable; }
interface IFeedS { function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80); }

/// @title Ethereum Sepolia smoke deployment of both Iceberg venues
/// @notice Official 1inch Aqua (same code as mainnet), the real Sepolia v4 PoolManager, Circle test USDC and WETH.
///         Morpho vaults do not exist on testnets, so here inventory stays in the wallet (Aqua) / pool (v4) and parking
///         is off. Proves the contracts deploy and trade on a public network; the economics live on Base.
/// @dev env: PK. Tiny sizes: ~$1.9 per venue.
contract SepoliaSmoke is Script {
    using PoolIdLibrary for PoolKey;

    address constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; // < WETH by address: currency0 on Sepolia
    address constant FEED = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = uint160((1 << 13) | (1 << 11) | (1 << 9) | (1 << 7) | (1 << 3));

    function run() external {
        uint256 pk = vm.envUint("PK");
        address me = vm.addr(pk);
        (, int256 px,,,) = IFeedS(FEED).latestRoundData();
        uint256 aquaWeth = 0.0007 ether; uint256 aquaUsdc = aquaWeth * uint256(px) / 1e20;
        uint256 hookWeth = 0.0005 ether; uint256 hookUsdc = hookWeth * uint256(px) / 1e20;

        vm.startBroadcast(pk);
        IWETH(WETH).deposit{ value: aquaWeth + hookWeth + 0.0002 ether }();
        IcebergRouter router = new IcebergRouter(AQUA, WETH, me, "Iceberg", "1");
        IcebergParams params = new IcebergParams();
        params.setKeeper(me, 0.1e18, 1e18);

        // 1inch Aqua venue: Salt + PA-AMM split (keeper λ via params) + 5 bps fee + stock XYCSwap
        bytes memory program = bytes.concat(Salt.build(1), PAActiveReserves.sourcedLambda(address(params), 0.5e18, 0.1e18), FeeFlatIn.build(0.0005e7), XYCSwap.build());
        ISwapVM.Order memory o = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: me, tokenA: USDC, tokenB: WETH, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false, allowZeroAmountIn: false,
            receiver: address(0), hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "", program: program
        }));
        IERC20(USDC).approve(AQUA, type(uint256).max); IERC20(WETH).approve(AQUA, type(uint256).max);
        IERC20(USDC).approve(address(router), type(uint256).max); IERC20(WETH).approve(address(router), type(uint256).max);
        address[] memory t = new address[](2); t[0] = USDC; t[1] = WETH;
        uint256[] memory a = new uint256[](2); a[0] = aquaUsdc; a[1] = aquaWeth;
        bytes32 h = IAqua(AQUA).ship(address(router), abi.encode(o), t, a);
        params.setLambda(me, h, 0.5e18, 0);

        // Uniswap v4 venue: IcebergHook through the real CREATE2 deployer (no vaults on testnet: parking off)
        IcebergHook.Config memory c = IcebergHook.Config(me, 500, 0.5e18, 0.1e18, 0.8e18, ILambdaSource(address(params)), IERC4626(address(0)), IERC4626(address(0)));
        bytes memory args = abi.encode(IPoolManager(PM), c);
        (address hookAddr, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(IcebergHook).creationCode, args);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, abi.encodePacked(type(IcebergHook).creationCode, args)));
        require(ok && hookAddr.code.length > 0, "hook deploy failed");
        IcebergHook hook = IcebergHook(hookAddr);
        PoolKey memory key = PoolKey(Currency.wrap(USDC), Currency.wrap(WETH), 0, 60, IHooks(hookAddr));
        IPoolManager(PM).initialize(key, 79228162514264337593543950336);
        IERC20(USDC).approve(hookAddr, type(uint256).max); IERC20(WETH).approve(hookAddr, type(uint256).max);
        hook.addLiquidity(BaseCustomAccounting.AddLiquidityParams(hookUsdc, hookWeth, 0, 0, block.timestamp + 600, 0, 0, bytes32(0)));
        hook.setKeeper(me);
        PoolSwapTest swapper = new PoolSwapTest(IPoolManager(PM));
        IERC20(USDC).approve(address(swapper), type(uint256).max); IERC20(WETH).approve(address(swapper), type(uint256).max);

        // one real trade on each venue: buy WETH with 0.1 USDC
        bytes memory td = TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: me, isExactIn: true, shouldUnwrapWeth: false, hasPreTransferInCallback: false, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: true, isAToB: true, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        }));
        (, uint256 outAqua,) = ISwapVM(address(router)).swap(o, 100_000, td);
        swapper.swap(key, SwapParams({ zeroForOne: true, amountSpecified: -100_000, sqrtPriceLimitX96: 4295128740 }), PoolSwapTest.TestSettings(false, false), "");
        vm.stopBroadcast();

        console.log("ROUTER", address(router));
        console.log("PARAMS", address(params));
        console.log("HOOK", hookAddr);
        console.log("SWAPPER", address(swapper));
        console.log("ORDER_HASH"); console.logBytes32(h);
        console.log("POOL_ID"); console.logBytes32(PoolId.unwrap(key.toId()));
        console.log("AQUA_FILL_WETH_OUT", outAqua);
    }
}
