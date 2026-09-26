// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { IcebergConfig as C } from "./IcebergConfig.sol";

/// @title IcebergLens
/// @notice Read-only helper so off-chain code (keeper, API, UI, demo) builds exactly the same Aqua order and taker
///         data as the Solidity deploy scripts, instead of re-implementing 1inch's MakerTraits / TakerTraits encoding.
contract IcebergLens {
    function order(address maker, address hooks, address params, address feed, uint64 salt) external pure returns (ISwapVM.Order memory) {
        return C.order(maker, hooks, params, feed, salt);
    }

    function sharedOrder(address maker, address officialHooks) external pure returns (ISwapVM.Order memory) {
        return C.sharedOrder(maker, officialHooks);
    }

    function takerData(address taker, bool sellWeth) external pure returns (bytes memory) {
        return C.takerData(taker, sellWeth);
    }
}
