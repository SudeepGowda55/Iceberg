// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/libs/MakerTraits.sol";

/// @title SwapVM102
/// @notice Order encoding for 1inch's OFFICIAL AquaSwapVMRouter deployed on Base (SwapVM v1.0.2), which predates the
///         swap-vm main branch Iceberg's own router is built from: no token pair in the order data, an array-indexed
///         opcode table (flat fee = 21, XYC = 17), and quote/swap taking tokenIn/tokenOut explicitly.
///         Mirrors v1.0.2 MakerTraitsLib.build for an Aqua order with post-transfer-in and pre-transfer-out hooks.
library SwapVM102 {
    uint8 internal constant OP_FLAT_FEE_IN = 21;
    uint8 internal constant OP_XYC_SWAP = 17;
    /// @dev EOA taker paying with transferFrom + Aqua push (v1.0.2 taker traits)
    bytes internal constant EOA_TAKER_TRAITS = hex"00000000000000000000000000000000000000000041";

    /// @param feeBps1e9 flat fee on the input, 1e9 = 100% (500_000 = 5 bps)
    function curveProgram(uint32 feeBps1e9) internal pure returns (bytes memory) {
        return abi.encodePacked(OP_FLAT_FEE_IN, uint8(4), feeBps1e9, OP_XYC_SWAP, uint8(0));
    }

    function aquaOrderWithHooks(address maker, address hooks, bytes memory hookData, bytes memory program) internal pure returns (ISwapVM.Order memory) {
        uint256 index0 = 0;                                  // no pre-transfer-in hook
        uint256 index1 = index0 + 20 + hookData.length;      // post-transfer-in: target + data
        uint256 index2 = index1 + 20 + hookData.length;      // pre-transfer-out: target + data
        uint256 index3 = index2;                             // no post-transfer-out hook
        uint64 idx = uint64(index0) | (uint64(index1) << 16) | (uint64(index2) << 32) | (uint64(index3) << 48);
        uint256 traits = (1 << 254)   // useAquaInsteadOfSignature
            | (1 << 251) | (1 << 250) // hasPostTransferInHook, hasPreTransferOutHook
            | (1 << 247) | (1 << 246) // postTransferIn / preTransferOut have explicit targets
            | (uint256(idx) << 160);  // receiver = 0 (maker)
        return ISwapVM.Order({ maker: maker, traits: MakerTraits.wrap(traits),
            data: bytes.concat(abi.encodePacked(hooks), hookData, abi.encodePacked(hooks), hookData, program) });
    }
}
