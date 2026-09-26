// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/libs/InstructionArgs.sol";

/// @dev Minimal surface of Uniswap v4 PoolManager we need: raw storage reads (EIP-2330 style extsload)
interface IPoolManagerExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice UniV4PegSwap opcode, linear quote pegged to the live Uniswap v4 pool spot price minus a maker spread
/// @dev Encoding: [address poolManager, bytes32 poolId, address currency1Token, uint24 spreadBps]
///   `currency1Token` is the Aqua-side token that corresponds to the v4 pool's currency1 (e.g. USDC for the
///   native-ETH/USDC pool, where currency0 is address(0) and the Aqua side holds WETH)
/// @dev Price is read from PoolManager storage (`_pools[poolId].slot0`) in the same block as the fill, so the
///   maker quote can never be stale relative to Uniswap. Combine with a manipulation bound (TWAP / Chainlink
///   deviation guard) before production use: v4 spot can be moved inside a transaction.
/// @dev Output is bounded by the maker's Aqua balance out; rounding favors the maker
library UniV4PegSwap {
    using InstructionArgs for bytes;
    using InstructionBuilder for MemoryPtr;
    using Math for uint256;

    error UniV4PegSwapWrongSpread(uint24 spreadBps);
    error UniV4PegSwapPoolNotInitialized(bytes32 poolId);
    error UniV4PegSwapInsufficientLiquidity(uint256 amountOut, uint256 balanceOut);
    error UniV4PegSwapTokenNotInPool(address tokenIn, address tokenOut, address currency1Token);

    /// @dev Free slot 0x52 in swap-vm's swap-curve bank (0x50-0x6f); no patch to 1inch's OpcodeList needed
    Opcode constant opcode = Opcode._52;
    uint256 constant BPS = 10_000;
    uint256 constant Q96 = 2 ** 96;
    /// @dev PoolManager `_pools` mapping is at storage slot 6; slot0 is the first word of the Pool.State struct
    uint256 constant POOLS_SLOT = 6;

    function sizeOf(address, bytes32, address, uint24) internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + 20 + 32 + 20 + 3;
    }

    function build(address poolManager, bytes32 poolId, address currency1Token, uint24 spreadBps) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf(poolManager, poolId, currency1Token, spreadBps)), poolManager, poolId, currency1Token, spreadBps).resolve();
    }

    function build(MemoryPtr ptrStart, address poolManager, bytes32 poolId, address currency1Token, uint24 spreadBps) internal pure returns (MemoryPtr ptr) {
        require(spreadBps < BPS, UniV4PegSwapWrongSpread(spreadBps));
        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(poolManager).push(uint256(poolId), 32).push(currency1Token).push(uint256(spreadBps), 3);
        ptrStart.patchLength(ptr);
    }

    function parse(bytes calldata args) internal pure returns (address poolManager, bytes32 poolId, address currency1Token, uint24 spreadBps) {
        poolManager = args.at(0).asAddress();
        poolId = bytes32(args.at(20).asU256());
        currency1Token = args.at(52).asAddress();
        spreadBps = args.at(72).asU24();
    }

    /// @notice Reads sqrtPriceX96 of the pool straight from PoolManager storage
    function sqrtPriceX96(address poolManager, bytes32 poolId) internal view returns (uint160 price) {
        bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
        bytes32 slot0 = IPoolManagerExtsload(poolManager).extsload(stateSlot);
        price = uint160(uint256(slot0));
        require(price != 0, UniV4PegSwapPoolNotInitialized(poolId));
    }

    function exec(Context memory ctx, bytes calldata args) internal view {
        (address poolManager, bytes32 poolId, address currency1Token, uint24 spreadBps) = parse(args);
        uint256 sqrtP = sqrtPriceX96(poolManager, poolId);
        bool inIsCurrency1 = ctx.query.tokenIn == currency1Token;
        require(inIsCurrency1 || ctx.query.tokenOut == currency1Token, UniV4PegSwapTokenNotInPool(ctx.query.tokenIn, ctx.query.tokenOut, currency1Token));

        if (ctx.query.isExactIn) {
            // Fair output at v4 spot, then keep (1 - spread) for the taker; floor favors maker
            uint256 fair = inIsCurrency1
                ? ctx.swap.amountIn.mulDiv(Q96, sqrtP).mulDiv(Q96, sqrtP)   // currency1 -> currency0
                : ctx.swap.amountIn.mulDiv(sqrtP, Q96).mulDiv(sqrtP, Q96);  // currency0 -> currency1
            ctx.swap.amountOut = fair * (BPS - spreadBps) / BPS;
        } else {
            // Gross up requested output by the spread, then price at v4 spot; ceil favors maker
            uint256 gross = ctx.swap.amountOut.mulDiv(BPS, BPS - spreadBps, Math.Rounding.Ceil);
            ctx.swap.amountIn = inIsCurrency1
                ? gross.mulDiv(sqrtP, Q96, Math.Rounding.Ceil).mulDiv(sqrtP, Q96, Math.Rounding.Ceil)
                : gross.mulDiv(Q96, sqrtP, Math.Rounding.Ceil).mulDiv(Q96, sqrtP, Math.Rounding.Ceil);
        }
        require(ctx.swap.amountOut <= ctx.swap.balanceOut, UniV4PegSwapInsufficientLiquidity(ctx.swap.amountOut, ctx.swap.balanceOut));
    }
}
