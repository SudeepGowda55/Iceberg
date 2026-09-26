# Iceberg internal review

Everything we found wrong while building and testing Iceberg, how it was fixed, and the test that now guards it. Found by tests, fork runs, the mainnet rehearsal and a line-by-line review of the contracts.

| # | Where | Finding | Severity | Fix | Guarded by |
|---|---|---|---|---|---|
| 1 | `IcebergRouter` | 1inch's `AquaSwapVMRouter` plus Iceberg's opcodes was 26,458 bytes, over the EIP-170 limit: it would not deploy on mainnet | High (deploy blocker) | λ policies moved to external `ILambdaSource` contracts; compiled at 200 optimizer runs; now 24,349 bytes | `test/unit/RouterSize.t.sol` |
| 2 | `PAActiveReserves` | A hostile or broken λ source could burn ~1.07B gas through try/catch (all gas forwarded) | High (griefing) | Source call gas-capped (now 600k, sized for MetaMorpho's `maxWithdraw`) | `test_keeperMode_brokenParamsFallBackInsteadOfReverting` (810k gas) |
| 3 | `IcebergHook` | Park/unpark unlock data (96 bytes) collided with OpenZeppelin's liquidity callback (also 96 bytes): every `addLiquidity` reverted | High (pool unusable) | Vault ops tagged with a 32-byte marker (128 bytes) | all `IcebergHookFork` tests |
| 4 | `IcebergHook` / params | A maker's Aqua vault balances would have capped the v4 hook's λ (the hook asked the source as its owner) | Medium | The hook is its own maker in `IcebergParams`; `setKeeper` registers the keeper with the pool's [λmin, maxλ], so λ can never exceed the parking guarantee | `test_keeperSource_setsLambda` |
| 5 | `IcebergParams` | Deliverability cap: MetaMorpho `maxWithdraw` costs ~302k gas, over the source's gas cap, so the cap silently did not apply | Medium | Nested try with its own gas; source gas raised to 600k; falls back to the held balance | `test_deliverabilityCap_lambdaNeverPromisesMoreThanTheVaultReleases` |
| 6 | `IcebergHook` | Every swap read `maxWithdraw` twice (~600k gas) | Low (cost) | Only read when the active side exceeds the in-pool claims | hook swap avg ~225k gas |
| 7 | `IcebergHook` | LP withdrawals reverted while reserves were parked (needed an operator to unpark first) | Medium (LP could be stuck) | `removeLiquidity` pulls the LP's share out of Morpho itself | `test_lpExitsWhileReservesAreParked_hookPullsFromMorpho` |
| 8 | `IcebergHook` | First-depositor share inflation (donation attack) | Medium | `MINIMUM_LIQUIDITY` (1,000 shares) locked on the first deposit | same test + `test_firstDeposit_tooSmallToCoverMinimumLiquidityReverts` |
| 9 | `IcebergHook` | A swap whose output exceeded in-pool claims reverted even though Morpho held the reserves | Medium | Active side capped at claims + withdrawable; shortfall unparked inside the swap | `test_swapBeyondInPoolClaims_unparksFromMorphoInsideTheSwap` |
| 10 | keeper / rebalance | A rebalance interrupted after `dock` left the position retired with no strategy live | High (position offline) | Rebalance is resumable (detects a retired strategy and completes the re-ship) | e2e + demo step 9 |
| 11 | keeper / API | Keeper and a manual rebalance signed with the maker key at the same time; nonces collided mid-rebalance | High (cause of #10) | Cross-process maker-key lock, re-entrant within the keeper | e2e + demo run back to back |
| 12 | shared liquidity | 1inch's official router on Base runs SwapVM v1.0.2: different order encoding, opcode table, hook and swap signatures than swap-vm main | High (feature broken) | `SwapVM102` encoder, v1.0.2 `postTransferIn` overload in `VaultedInventoryHooks`, v1.0.2 ABI off-chain | `SharedLiquidityFork` |
| 13 | UI | `HookSwap` amounts are both positive: a buy was shown as a sell | Low | Direction from which currency paid the LP fee | e2e activity label check |
| 14 | replay harness | `via_ir` caches `block.number` across `vm.roll` in a loop: every "minute" ran in one block and overstated the gain (50% instead of 17.6%) | High (wrong evidence) | Explicit block counter; LP loss measured mark-to-market vs a rebalanced portfolio | `Replay21Sep` (λ=1 must match plain v4) |
| 15 | fill scripts | `forge script` simulates all fills in one block but broadcasts one per block; sells asked for more WETH than the buys really returned | Low | Sells return 95% of the simulated buy | mainnet rehearsal |

## Checked and accepted

- **Deliverability cap depends on the first fill's direction in a block.** A first fill in the illiquid direction can lower λ for the rest of that block. It can only reduce exposure, never increase it.
- **Keeper trust.** The keeper can only move λ inside the maker's (or the hook's) box, and can be revoked. It cannot move funds.
- **Vault trust.** Vaults are set by the maker (Aqua) or fixed at hook deployment. A vault that refuses withdrawals makes fills revert (fails closed); it cannot take funds.
- **v4 spot manipulation (Aqua program's guard).** Bounded to 1% by `ChainlinkDeviationGuard`, not removed.
- **Weight-tracking rebalance cost.** Each rebalance pays Uniswap v3's 5 bps fee and slippage on the excess. Only triggered outside a ±2% band.
