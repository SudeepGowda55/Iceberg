// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Context } from "@1inch/swap-vm/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/libs/InstructionArgs.sol";
import { IcebergMath } from "./IcebergMath.sol";
import { UniV4PegSwap } from "./UniV4PegSwap.sol";

interface IAggregatorV3 { function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80); }

/// @title ChainlinkDeviationGuard
/// @notice Refuses to trade when the Uniswap v4 price the strategy relies on is far from Chainlink, or when
///         Chainlink itself is stale. A v4 spot price can be pushed inside one transaction (flash liquidity);
///         Chainlink cannot, so this bounds how far a manipulated pool can drag Iceberg's reference. It bounds the
///         attack, it does not remove it: moves smaller than `maxDevBps` still pass.
/// @dev Encoding (80 bytes): feed address | maxAge u32 | maxDevBps u16 | poolManager address | poolId bytes32 |
///      dec0 u8 | dec1 u8. The feed must quote currency0 in units of currency1 (e.g. ETH/USD for ETH/USDC).
library ChainlinkDeviationGuard {
    using InstructionArgs for bytes;
    using InstructionBuilder for MemoryPtr;

    error GuardStaleOracle(uint256 age, uint256 maxAge);
    error GuardBadOracle(int256 answer);
    error GuardDeviation(uint256 v4PriceWad, uint256 oraclePriceWad, uint256 maxDevBps);

    /// @dev Free slot 0x21 in swap-vm's conditions & guards bank (0x20-0x3f)
    Opcode constant opcode = Opcode._21;

    function sizeOf() internal pure returns (uint256) { return InstructionBuilder.sizeOf() + 80; }

    function build(address feed, uint32 maxAge, uint16 maxDevBps, address poolManager, bytes32 poolId, uint8 dec0, uint8 dec1) internal pure returns (bytes memory) {
        MemoryPtr ptrStart = MemoryPtrLib.alloc(sizeOf());
        MemoryPtr ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(feed).push(uint256(maxAge), 4).push(uint256(maxDevBps), 2).push(poolManager).push(uint256(poolId), 32)
            .push(uint256(dec0), 1).push(uint256(dec1), 1);
        ptrStart.patchLength(ptr);
        return ptr.resolve();
    }

    function exec(Context memory, bytes calldata args) internal view {
        address feed = args.at(0).asAddress();
        uint32 maxAge = args.at(20).asU32();
        uint16 maxDevBps = args.at(24).asU16();
        address pm = args.at(26).asAddress();
        bytes32 poolId = bytes32(args.at(46).asU256());
        uint8 dec0 = args.at(78).asU8();
        uint8 dec1 = args.at(79).asU8();
        check(feed, maxAge, maxDevBps, IcebergMath.priceFromSqrtX96(UniV4PegSwap.sqrtPriceX96(pm, poolId), dec0, dec1));
    }

    /// @notice Shared by the v4 hook: reverts unless `priceWad` is within `maxDevBps` of a fresh Chainlink answer
    function check(address feed, uint256 maxAge, uint256 maxDevBps, uint256 priceWad) internal view returns (uint256 oracleWad) {
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        require(answer > 0, GuardBadOracle(answer));
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0; // a future timestamp reads as fresh, never underflows
        require(age <= maxAge, GuardStaleOracle(age, maxAge));
        oracleWad = uint256(answer) * 1e10; // Chainlink USD feeds have 8 decimals
        uint256 diff = priceWad > oracleWad ? priceWad - oracleWad : oracleWad - priceWad;
        require(diff * 10_000 <= oracleWad * maxDevBps, GuardDeviation(priceWad, oracleWad, maxDevBps));
    }
}
