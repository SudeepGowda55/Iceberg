// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title ILambdaSource
/// @notice A pluggable activeness policy for PAActiveReserves. The router calls it once per strategy per block,
///         gas-capped and inside try/catch: a source that reverts, runs out of gas or answers `ok = false` makes the
///         instruction fall back to the λ written in the maker's program. New policies need no router redeploy.
interface ILambdaSource {
    /// @param maker Strategy owner
    /// @param orderHash Aqua order hash of the strategy
    /// @param tokenIn Token the taker pays
    /// @param tokenOut Token the taker receives
    /// @param balanceIn Strategy's total Aqua balance of tokenIn at the start of the block's first fill
    /// @param balanceOut Strategy's total Aqua balance of tokenOut at the start of the block's first fill
    /// @return lambdaWad Activeness λ in wad
    /// @return ok False to request the program fallback
    function lambdaOf(address maker, bytes32 orderHash, address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut)
        external view returns (uint256 lambdaWad, bool ok);
}
