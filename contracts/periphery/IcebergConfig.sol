// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { Salt } from "@1inch/swap-vm/instructions/Controls.sol";
import { SwapVM102 } from "./SwapVM102.sol";
import { FeeFlatIn } from "@1inch/swap-vm/instructions/FeeFlat.sol";
import { PAActiveReserves } from "../iceberg/PAActiveReserves.sol";
import { ChainlinkDeviationGuard } from "../iceberg/ChainlinkDeviationGuard.sol";

/// @title IcebergConfig
/// @notice Base mainnet addresses and the one Iceberg position the scripts deploy, ship and fill.
///         Ship and Fill both rebuild the order from here, so they always agree on the order hash.
library IcebergConfig {
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;       // official 1inch Aqua
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b; // Uniswap v4 on Base
    bytes32 internal constant POOL_ID = 0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a; // native ETH/USDC 0.05%
    address internal constant FEED_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70; // Chainlink ETH/USD on Base
    address internal constant VAULT_WETH = 0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1;   // Moonwell Flagship ETH (Morpho)
    address internal constant VAULT_USDC = 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183;   // Steakhouse USDC (Morpho)

    /// @dev 1inch's official, unmodified AquaSwapVMRouter on Base (shared-liquidity strategy)
    address internal constant OFFICIAL_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    /// @dev slice of the same vaulted inventory also committed to the official-router strategy (Aqua shared liquidity)
    uint256 internal constant SHARED_BPS = 3000;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @dev BaseCustomCurve permissions: beforeInitialize, beforeAdd/RemoveLiquidity, beforeSwap, beforeSwapReturnDelta
    uint160 internal constant HOOK_FLAGS = uint160((1 << 13) | (1 << 11) | (1 << 9) | (1 << 7) | (1 << 3));
    /// @dev v4 venue: 5 bps swap fee (pips) and the λ ceiling that bounds how much may be parked in Morpho
    uint24 internal constant HOOK_FEE_PIPS = 500;
    uint64 internal constant HOOK_MAX_LAMBDA = 0.8e18;

    /// @dev 5 bps flat fee on the input (FeeFlatIn uses 1e7 = 100%)
    uint24 internal constant FEE = 0.0005e7;
    /// @dev program λ used until the keeper publishes one, and the floor λ can never go under
    uint64 internal constant FALLBACK_LAMBDA = 0.5e18;
    uint64 internal constant MIN_LAMBDA = 0.1e18;
    /// @dev guard: Chainlink at most 1 hour old, v4 spot within 1% of it
    uint32 internal constant ORACLE_MAX_AGE = 3600;
    uint16 internal constant MAX_DEV_BPS = 100;

    /// @param feed Chainlink ETH/USD on mainnet; on a local fork, a MirrorFeed that copies the live Base answer
    /// @param salt Aqua never re-ships a docked strategy; the keeper's rebalance re-ships with salt + 1
    function program(address params, address feed, uint64 salt) internal pure returns (bytes memory) {
        return bytes.concat(
            Salt.build(salt),
            ChainlinkDeviationGuard.build(feed, ORACLE_MAX_AGE, MAX_DEV_BPS, POOL_MANAGER, POOL_ID, 18, 6),
            PAActiveReserves.sourcedLambda(params, FALLBACK_LAMBDA, MIN_LAMBDA),
            FeeFlatIn.build(FEE),
            XYCSwap.build()
        );
    }

    /// @notice The vault-backed, partially active position: inventory lives in Morpho, only λ of it trades per block
    function order(address maker, address hooks, address params, address feed, uint64 salt) internal pure returns (ISwapVM.Order memory) {
        bytes memory vaults = abi.encode(VAULT_WETH, VAULT_USDC); // ordered by token address (WETH < USDC)
        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false,
            allowZeroAmountIn: false, receiver: address(0),
            hasPreTransferInHook: false, hasPostTransferInHook: true, hasPreTransferOutHook: true, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: hooks, postTransferInData: vaults,
            preTransferOutTarget: hooks, preTransferOutData: vaults, postTransferOutTarget: address(0), postTransferOutData: "",
            program: program(params, feed, salt)
        }));
    }

    /// @notice Aqua shared liquidity: a plain 5 bps constant-product strategy on 1inch's OFFICIAL router, backed by the
    ///         same Morpho vault shares as the Iceberg position (its own vault-hooks instance, bound to the official router)
    function sharedOrder(address maker, address officialHooks) internal pure returns (ISwapVM.Order memory) {
        // encoded for the official router's SwapVM v1.0.2 (see SwapVM102): 5 bps flat fee then x*y=k
        return SwapVM102.aquaOrderWithHooks(maker, officialHooks, abi.encode(VAULT_WETH, VAULT_USDC), SwapVM102.curveProgram(500_000));
    }

    /// @notice Taker data for an EOA taker: the router pulls the input with transferFrom and pushes it into Aqua
    function takerData(address taker, bool sellWeth) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: taker, isExactIn: true, shouldUnwrapWeth: false, hasPreTransferInCallback: false, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: true, isAToB: sellWeth,
            allowPartialFill: false, usePermit2: false, threshold: "", to: address(0), deadline: 0,
            preTransferInHookData: "", postTransferInHookData: "", preTransferOutHookData: "", postTransferOutHookData: "",
            preTransferInCallbackData: "", preTransferOutCallbackData: "", instructionsArgs: "", signature: ""
        }));
    }
}
