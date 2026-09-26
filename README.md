# Iceberg

**A Partially Active AMM on 1inch Aqua and Uniswap v4: in any block, arbitrageurs can reach only a fraction λ of the reserves. λ is chosen by a fee-aware keeper from recent real prices, and the idle reserves earn yield in Morpho vaults until the moment they are needed.**

On a replay of the real 24 hours ending 21 Sep 2026 (ETH +6.24%), on a Base mainnet fork with the real Uniswap v4 PoolManager and official Aqua, Iceberg cut what liquidity providers lost to arbitrage by **17.6% at λ = 50% and 19.3% at λ = 39%**, compared with a real plain Uniswap v4 pool at the same 5 bps fee.

Built at ETHGlobal Tokyo 2026 for 1inch *Build an Aqua App* and Uniswap *Best Uniswap Stack Contribution*.

## How it works

**Algorithm 1 of the paper, every block.** On the first trade of a block, total reserves R are split into an active part λ·R and a passive part (1 − λ)·R. The passive part is frozen for the rest of the block. Every trade in that block sees only `total − passive`, on a constant-product curve with a 5 bps fee on the input. Quotes never write storage, so quote == swap.

**One kernel, two venues** ([IcebergMath](contracts/iceberg/IcebergMath.sol)):

| | 1inch Aqua | Uniswap v4 |
|---|---|---|
| Contract | [`PAActiveReserves`](contracts/iceberg/PAActiveReserves.sol), a SwapVM instruction in free opcode slot 0x92, followed by 1inch's stock `FeeFlatIn` + `XYCSwap` | [`IcebergHook`](contracts/v4/IcebergHook.sol) on OpenZeppelin's `BaseCustomCurve`; the hook owns the reserves as ERC-6909 claims |
| Router / pool | [`IcebergRouter`](contracts/iceberg/IcebergRouter.sol) = 1inch's `AquaSwapVMRouter` unchanged + Iceberg opcodes (0x21 guard, 0x52 v4 peg, 0x92 split); stock Aqua programs behave exactly as on the official router | WETH/USDC pool on the real Base PoolManager, hook deployed through the real CREATE2 deployer at a mined address |
| Where idle funds sit | The maker holds only Morpho vault shares. [`VaultedInventoryHooks`](contracts/iceberg/VaultedInventoryHooks.sol) withdraw exactly the fill at the moment of the fill and deposit the proceeds back | Passive reserves are parked in Morpho (`park` / `unpark`), never more than (1 − max λ) |
| λ | Same pluggable [`ILambdaSource`](contracts/iceberg/ILambdaSource.sol): the fee-aware keeper ([IcebergParams](contracts/iceberg/IcebergParams.sol), inside a maker-controlled box, revocable) or Theorem 1. Called gas-capped inside try/catch; a broken source falls back to the program λ | Same |

Same reserves, same λ and same fee give **the same price to the wei on both venues**: a buy/sell sequence across blocks matches exactly ([test](test/fork/IcebergHookFork.t.sol)).

**Never promise more than can be delivered.** On Aqua, [IcebergParams](contracts/iceberg/IcebergParams.sol) caps λ at what the maker's wallet plus Morpho vault can release right now (MetaMorpho `maxWithdraw`). On v4, the hook caps its active side at its in-pool claims plus what its vault will release, and **pulls any shortfall out of Morpho inside the swap**. LPs can always exit: `removeLiquidity` unparks their share itself.

**Weight tracking (rebalancing).** A partially active pool lags the market, so its mix drifts, which is the cost the paper names. When the Aqua position's ETH weight at the live price leaves 50% ± 2%, the keeper:
1. retires the strategy (`dock`);
2. rebalances the maker's Morpho holdings to 50/50 through Uniswap v3 (WETH/USDC 0.05%);
3. re-ships with a new salt, balanced at the live price.

This resets a stale curve price without paying arbitrageurs. It is resumable if interrupted, and serialised with the keeper through a maker-key lock.

**Aqua shared liquidity.** The same Morpho vault shares also back a plain 5 bps strategy on **1inch's official, unmodified router**. One balance, two strategies, and each fill withdraws exactly what it needs. The official router on Base runs SwapVM v1.0.2, so that order is encoded by [SwapVM102](contracts/periphery/SwapVM102.sol).

**The fee-aware keeper** ([frontend/scripts/keeper.ts](frontend/scripts/keeper.ts)) runs on its own timer:
1. It reads live Base Chainlink.
2. Every ~10 minutes it takes the last 6 hours of real ETH/USD and simulates each λ from 100% down to the floor at the pool's fee.
3. It publishes the λ with the lowest LP loss to both venues.
4. It keeps the v4 pool's idle reserves parked in Morpho.
5. It rebalances the Aqua position when its weight drifts outside the band.

Every decision is logged with the table behind it, and the UI charts it.

## Evidence

| Claim | Result | Reproduce |
|---|---|---|
| Real replay, 21 Sep 2026 (1,440 min, 5 bps) | LP loss vs a perfectly rebalanced portfolio: plain v4 $1.077 · Iceberg λ 100% $1.076 · **λ 50% $0.888 (−17.6%) · λ 39% $0.869 (−19.3%)** · Aqua λ 50% $0.888 (identical to the hook) | `REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv` → [research/replay_2026-09-21_1440min.json](research/replay_2026-09-21_1440min.json) |
| Fee-dependence (7 days, real ETH/USD) | −32% at 1 bps, −17% at 5 bps, ≈0 or worse at 30 bps | `node research/lambda_policy.mjs` |
| Kernel matches the paper | λ\* within 1e-16, Theorem 1 within 5e-15, ln within 8e-11 of the float reference; v2 closed form satisfies the paper's fixed point | `forge test --match-path test/unit/IcebergMath.t.sol -vv` |
| 1inch's own invariants hold | `CoreInvariants` (symmetry, additivity, quote == swap, monotonicity, rounding favours maker, balance sufficiency) at λ = 1, 0.5, 0.25, with and without fee | `forge test --match-path test/invariant/PAInvariants.t.sol` |
| Works on real Base contracts | 11 Aqua fork tests (split, same-block second fill, re-split, passive untradable, keeper bounds and fallback, gas-capped source, Theorem 1, Chainlink guard, vaulted + partially active) and 11 v4 hook fork tests (split, λ source, exact-out, park/unpark with real vault yield, blocked direct liquidity, parity with Aqua, real CREATE2 deploy) | `BASE_RPC_URL=https://mainnet.base.org forge test` (52 tests) |
| Whole stack end to end | keeper, both venues, API swaps, per-block splits, vault moves, activity labels, UI | `./scripts/test_all.sh` |
| Mainnet run with one wallet | rehearsed on a fork with the real wallet and balance: 87 transactions (both venues, 20 Aqua fills, 10 v4 swaps, keeper λ updates, a rebalance, 2 shared-liquidity fills), **$0.74 of gas** | `./scripts/rehearse_mainnet.sh` |
| Aqua on Base, measured | 872 strategies from 144 makers since launch; **51.7% never got a single fill**; 66 makers never got any; of 80 live never-filled strategies, 41 have no money behind them (wallet balance or approval is zero) | `node research/aqua_base_study.mjs` → [research/aqua_base_study.json](research/aqua_base_study.json) |
| Shared liquidity on 1inch's real official router | Iceberg position and official-router strategy both filled from one maker's Morpho shares | `forge test --match-path test/fork/SharedLiquidityFork.t.sol` |
| Contracts we build on are genuine | Aqua, official router, PoolManager, both MetaMorpho vaults, Chainlink: source-verified on Base; Aqua has identical code on Base, Ethereum and Polygon | `./scripts/verify_contracts.sh` |
| Ethereum Sepolia (public testnet) | Both venues deployed and traded, 21 transactions, all successful: router `0x41983C692Fd7ef800aC6C9E5F1f90737e1C5a79F`, hook `0x5e6FF9B22d2cf653559Ecc519394C1Ec8a842A88`; Aqua fill [`0x321ee148…`](https://sepolia.etherscan.io/tx/0x321ee1482759a2393852a0b3b156bc6e65e3f897203297fe440baf296c4223b1), v4 swap [`0xd00ff66f…`](https://sepolia.etherscan.io/tx/0xd00ff66f1e04045d731f527d36055e5fe5bb0f55fdba9abbfc37045b7e16033f) | `PK=… forge script script/Sepolia.s.sol:SepoliaSmoke --rpc-url <sepolia> --broadcast` |
| Base mainnet | _transaction hashes listed here after the run_ | `CONFIRM=yes ./scripts/deploy_mainnet.sh` |

## Run it

```bash
git clone --recurse-submodules <repo> iceberg && cd iceberg
(cd lib/swap-vm && yarn install --ignore-scripts) && npm install && (cd frontend && npm install)
forge build
./scripts/test_all.sh            # every Solidity test + a fresh local stack + end-to-end check + terminal demo
open http://localhost:8788/      # UI; the terminal demo: (cd frontend && PAUSE=1 npx tsx scripts/demo.ts)
./scripts/stop_local.sh
```

Watch everything live in the terminal (every swap, split, vault move, park, λ update, rebalance and keeper tick; the same feed as the UI):

```bash
(cd frontend && npm run watch)
(cd frontend && npm run swap -- official buy 5)     # one real swap: v4 | aqua | official
(cd frontend && FORCE=1 npm run rebalance)          # weight-tracking rebalance now
tail -f .run/keeper.log                             # the keeper's own log
```

API (local fork):

```bash
curl -s localhost:8788/api/status | jq                                     # both venues, λ, active vs passive, Morpho, keeper
curl -s "localhost:8788/api/quote?venue=aqua&side=buy&usd=25" | jq         # quote on either venue
curl -s -X POST "localhost:8788/api/swap?venue=v4&side=buy&usd=25" | jq    # real swap (tx hash), appears live in the UI
curl -s localhost:8788/api/activity | jq '.counts'                         # splits, swaps, vault moves, λ updates, rebalances
curl -s -X POST "localhost:8788/api/rebalance?force=1" | jq                # weight-tracking rebalance (retire, Uniswap, re-ship)
```

Run-of-show for the split-screen demo: [DEMO.md](DEMO.md). Uniswap developer feedback: [FEEDBACK.md](FEEDBACK.md). Every issue found while building, with its fix and guarding test: [docs/REVIEW.md](docs/REVIEW.md).

## Hacky parts worth knowing

- **Contract size.** 1inch's `AquaSwapVMRouter` is already 21,981 bytes, and adding the λ policies inline pushed it to 26,458. We moved policies into external `ILambdaSource` contracts and compiled at 200 optimizer runs, which gives 24,349.
- **Vault ops and liquidity callbacks.** The v4 hook routes park/unpark through the PoolManager's `unlock`. OpenZeppelin's liquidity callback data is exactly 96 bytes, so vault operations are tagged with a 32-byte marker (128 bytes) to never be confused with it.
- **A gas-griefing hole caught in testing.** A hostile λ source could burn about 1B gas through try/catch. The read is now capped at 100k gas.
- **HookSwap amounts are both positive** in OpenZeppelin's event. Direction is inferred from which currency paid the LP fee.
- **Foundry with `via_ir` caches `block.number`** across `vm.roll` in a loop. The replay keeps its own block counter; otherwise every "minute" lands in the same block.
- **Base Chainlink and anvil.** A fork's Chainlink freezes, so the local stack mirrors the live answer. The rehearsal and mainnet flows price against real Chainlink.

## Related work and credits

- **Partially Active AMMs**, Sunghun Ko, [arXiv 2602.09887](https://arxiv.org/abs/2602.09887). Iceberg implements Algorithm 1, the closed-form λ\*(γ) and Theorem 1.
- **Tide** (ETHGlobal Tokyo 2026, concurrent work) also implements PA-AMM on Aqua and Uniswap v4, on Sepolia, with an agent-proposed λ and a second paper's deep virtual curve. Iceberg differs in the fee-aware λ, running on Base mainnet, vault-held reserves on both venues, and a single-curve core.
- **Barker** (ETHOnline 2026) showed vault-backed Aqua quotes on a fork. Iceberg brings vault-held inventory to mainnet, inside a PA-AMM position, and to a v4 hook.
- **1inch** Aqua and SwapVM (router, `XYCSwap`, `FeeFlatIn`, `CoreInvariants`) are used unmodified. **OpenZeppelin** uniswap-hooks `BaseCustomCurve` is the hook base. Morpho vaults: Moonwell Flagship ETH, Steakhouse USDC.

## AI use

Built with Claude Code (Anthropic). AI wrote most of the code, tests and docs under the author's direction. Every number above comes from the command next to it.
