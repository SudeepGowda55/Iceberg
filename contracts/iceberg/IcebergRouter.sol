// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/routers/AquaSwapVMRouter.sol";
import { UniV4PegSwap } from "./UniV4PegSwap.sol";
import { PAActiveReserves } from "./PAActiveReserves.sol";
import { ChainlinkDeviationGuard } from "./ChainlinkDeviationGuard.sol";

/// @title IcebergRouter
/// @notice 1inch's official AquaSwapVMRouter, unchanged, plus Iceberg's instructions in free opcode slots.
///         Every stock Aqua program behaves exactly as on the official router; unknown opcodes fall through to it.
contract IcebergRouter is AquaSwapVMRouter {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        AquaSwapVMRouter(aqua, weth, owner, name, version) { }

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == PAActiveReserves.opcode.asU8()) PAActiveReserves.exec(ctx, args);
        else if (opcode == ChainlinkDeviationGuard.opcode.asU8()) ChainlinkDeviationGuard.exec(ctx, args);
        else if (opcode == UniV4PegSwap.opcode.asU8()) UniV4PegSwap.exec(ctx, args);
        else super._runOpcode(ctx, opcode, args);
    }
}
