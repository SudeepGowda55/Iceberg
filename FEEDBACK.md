# Uniswap developer feedback (from building Iceberg)

Things we ran into building a custom-curve v4 hook (`IcebergHook`, on OpenZeppelin's `BaseCustomCurve`) and testing it against the real Base PoolManager. Each item is something that cost us time, with what would have helped.

## 1. `HookSwap` amounts don't tell you the direction
OpenZeppelin's `BaseCustomCurve` emits `HookSwap(id, sender, amount0, amount1, fee0, fee1)` with both amounts positive (specified and unspecified). An indexer or UI can't tell a buy from a sell from the amounts alone. We shipped a feed that labelled a buy as a sell before noticing. We now infer direction from which currency paid the LP fee.
**Would help:** signed amounts (from the pool's point of view) in the recommended `HookSwap` event, or an explicit `zeroForOne` field. The docs recommending `HookSwap`/`HookFee` should say what the signs mean.

## 2. Custom `unlock` operations collide with the base's callback data
Our hook parks idle reserves in ERC-4626 vaults, which needs its own `poolManager.unlock` → `unlockCallback` path. `BaseCustomCurve.unlockCallback` decodes a 96-byte `(address, int128, int128)`, and our first encoding `(uint8, uint8, uint256)` was also 96 bytes. The liquidity callback got decoded as a vault operation, and every `addLiquidity` reverted with no reason.
**Would help:** a documented pattern (or a typed op / selector prefix in the base) for hooks that need more than one kind of unlock callback.

## 3. PoolManager storage layout is only reachable through `StateLibrary`
Our 1inch SwapVM instruction reads a v4 pool's `slot0` from another contract via `extsload`. We had to find the `_pools` mapping slot (6) by reading source; `StateLibrary` does it, but the layout isn't documented as a stable interface.
**Would help:** state explicitly in the docs that `StateLibrary`'s slot constants are part of the stable surface for external integrators (non-hook contracts reading pool state).

## 4. Initializing a test pool can collide with a live canonical pool on a fork
Our fork replay created a plain WETH/USDC pool with fee 500 / tickSpacing 10 / no hook to compare against. That key is the live canonical 0.05% pool on Base, so `initialize` reverted (already initialized). Obvious in hindsight, but the revert doesn't say which pool it collided with.
**Would help:** the `PoolAlreadyInitialized` error carrying the pool id, and a note in the fork-testing docs.

## 5. Hook address mining in scripts
`HookMiner` (v4-periphery `src/utils`) plus the CREATE2 deployer at `0x4e59…956C` worked first time on the real Base PoolManager, and the flag check in `BaseHook`'s constructor caught nothing because the mined address was right. A one-page "deploy a hook to mainnet" guide covering `HookMiner.find`, the CREATE2 call, and verifying `Hooks.validateHookPermissions` would have saved us reading periphery source.

## What worked well
- `BaseCustomCurve` + ERC-6909 claims made "the hook owns the reserves" a small amount of code: no float, no sweeping, and swaps settle by burning and minting claims inside `beforeSwap`.
- `PoolSwapTest` and `PoolModifyLiquidityTest` against the real Base PoolManager on an anvil fork gave us a faithful baseline. A real full-range v4 pool and our hook at λ = 100% lost the same to arbitrage to within 0.1% over 1,440 minutes.
