// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/libs/InstructionArgs.sol";
import { IcebergMath } from "./IcebergMath.sol";
import { ILambdaSource } from "./ILambdaSource.sol";

/// @title PAActiveReserves
/// @notice Partially Active AMM (Ko 2026, arXiv 2602.09887, Algorithm 1) as a SwapVM instruction.
///         On the first fill of each block the strategy's Aqua balances are split into an active part λ·R and a
///         passive part (1-λ)·R. The passive part is fixed for the rest of the block; every fill in that block only
///         sees `total - passive`, so the curve that follows (1inch's stock XYCSwap) trades the active pair alone.
///         Place it right before the curve: [..guards..] PAActiveReserves XYCSwap [fee].
/// @dev λ source (mode):
///        0 FIXED   λ from the program
///        1 SOURCE  λ from an external ILambdaSource (the fee-aware keeper in IcebergParams, the paper's Theorem 1 in
///                  Theorem1Source, or any future policy). Called gas-capped inside try/catch; on failure or ok = false
///                  the program λ is used, so a policy can never freeze fills or burn the taker's gas.
///      λ is always clipped to [λmin, 1]. Quotes never write storage: when no split is stored for this block it is
///      computed from current balances, exactly as the first swap of the block will compute and store it, so quote == swap.
/// @dev Encoding (37 bytes): mode u8 | lambdaWad u64 | lminWad u64 | source address
library PAActiveReserves {
    using InstructionArgs for bytes;
    using InstructionBuilder for MemoryPtr;

    error PAActiveSideEmpty(uint256 activeIn, uint256 activeOut);
    error PABadMode(uint8 mode);

    /// @dev Free slot 0x92 in swap-vm's balance-tuning bank (0x90-0xaf)
    Opcode constant opcode = Opcode._92;
    uint8 constant MODE_FIXED = 0;
    uint8 constant MODE_SOURCE = 1;
    /// @dev gas given to an external λ source: Theorem1Source needs ~40k; IcebergParams' deliverability cap reads a
    ///      MetaMorpho vault's maxWithdraw, which walks its withdraw queue (~100-200k)
    uint256 constant SOURCE_GAS = 600_000;

    struct Args {
        uint8 mode;
        uint64 lambdaWad;
        uint64 lminWad;
        address source;
    }

    // ERC-7201: keccak256(abi.encode(uint256(keccak256("iceberg.storage.PAActiveReserves")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 constant STORAGE_SLOT = 0xfabd6331e5dc79e94909edfa47f08fc600c5100d62072d0dc6767da2435c9700;

    struct Storage {
        /// @dev packed: block number (high 64 bits) | passive amount (low 192 bits)
        mapping(bytes32 orderHash => mapping(address token => uint256 packed)) split;
    }

    event PASplit(bytes32 indexed orderHash, address indexed token, uint256 blockNumber, uint256 lambdaWad, uint256 passive);

    function store() internal pure returns (Storage storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly ("memory-safe") { $.slot := slot }
    }

    // ------------------------------------------------------------------------------------------ building

    function sizeOf() internal pure returns (uint256) { return InstructionBuilder.sizeOf() + 37; }

    function build(Args memory a) internal pure returns (bytes memory) {
        require(a.mode <= MODE_SOURCE, PABadMode(a.mode));
        MemoryPtr ptrStart = MemoryPtrLib.alloc(sizeOf());
        MemoryPtr ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(uint256(a.mode), 1).push(uint256(a.lambdaWad), 8).push(uint256(a.lminWad), 8).push(a.source);
        ptrStart.patchLength(ptr);
        return ptr.resolve();
    }

    function fixedLambda(uint64 lambdaWad) internal pure returns (bytes memory) {
        return build(Args(MODE_FIXED, lambdaWad, 0, address(0)));
    }

    /// @param source An ILambdaSource (IcebergParams for the keeper, Theorem1Source for the paper's policy)
    function sourcedLambda(address source, uint64 fallbackLambdaWad, uint64 lminWad) internal pure returns (bytes memory) {
        return build(Args(MODE_SOURCE, fallbackLambdaWad, lminWad, source));
    }

    function parse(bytes calldata args) internal pure returns (Args memory a) {
        a.mode = args.at(0).asU8();
        a.lambdaWad = args.at(1).asU64();
        a.lminWad = args.at(9).asU64();
        a.source = args.at(17).asAddress();
    }

    // ------------------------------------------------------------------------------------------ execution

    function exec(Context memory ctx, bytes calldata args) internal {
        Storage storage $ = store();
        bytes32 h = ctx.query.orderHash;
        (uint256 bIn, uint256 pIn) = _unpack($.split[h][ctx.query.tokenIn]);
        (uint256 bOut, uint256 pOut) = _unpack($.split[h][ctx.query.tokenOut]);
        bool freshIn = bIn != block.number;
        bool freshOut = bOut != block.number;

        uint256 lambdaWad;
        if (freshIn || freshOut) {
            lambdaWad = lambdaOf(ctx, parse(args));
            if (freshIn) (, pIn) = IcebergMath.split(ctx.swap.balanceIn, lambdaWad);
            if (freshOut) (, pOut) = IcebergMath.split(ctx.swap.balanceOut, lambdaWad);
        }

        uint256 activeIn = ctx.swap.balanceIn > pIn ? ctx.swap.balanceIn - pIn : 0;
        uint256 activeOut = ctx.swap.balanceOut > pOut ? ctx.swap.balanceOut - pOut : 0;
        // An empty active side would let a constant-product curve quote the whole other side; refuse instead
        require(activeIn != 0 && activeOut != 0, PAActiveSideEmpty(activeIn, activeOut));
        ctx.swap.balanceIn = activeIn;
        ctx.swap.balanceOut = activeOut;

        if (!ctx.vm.isStaticContext) {
            if (freshIn) { $.split[h][ctx.query.tokenIn] = _pack(block.number, pIn); emit PASplit(h, ctx.query.tokenIn, block.number, lambdaWad, pIn); }
            if (freshOut) { $.split[h][ctx.query.tokenOut] = _pack(block.number, pOut); emit PASplit(h, ctx.query.tokenOut, block.number, lambdaWad, pOut); }
        }
    }

    /// @notice λ for this block, never reverts: failed or declined source reads fall back to the program's λ
    function lambdaOf(Context memory ctx, Args memory a) internal view returns (uint256) {
        if (a.mode == MODE_SOURCE && a.source != address(0)) {
            try ILambdaSource(a.source).lambdaOf{ gas: SOURCE_GAS }(
                ctx.query.maker, ctx.query.orderHash, ctx.query.tokenIn, ctx.query.tokenOut, ctx.swap.balanceIn, ctx.swap.balanceOut
            ) returns (uint256 l, bool ok) {
                if (ok) return _clip(l, a.lminWad);
            } catch { }
        }
        return _clip(a.lambdaWad, a.lminWad);
    }

    function _clip(uint256 lambdaWad, uint256 lminWad) private pure returns (uint256) {
        if (lambdaWad > 1e18) lambdaWad = 1e18;
        return lambdaWad < lminWad ? lminWad : lambdaWad;
    }

    function _pack(uint256 blockNumber, uint256 passive) private pure returns (uint256) {
        return (blockNumber << 192) | uint192(passive);
    }

    function _unpack(uint256 packed) private pure returns (uint256 blockNumber, uint256 passive) {
        return (packed >> 192, uint192(packed));
    }
}
