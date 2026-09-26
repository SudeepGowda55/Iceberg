# Iceberg demo run-of-show (about 4 minutes, split screen)

**Left:** terminal in `iceberg/`. **Right:** browser at `http://localhost:8788/`.
Everything fired from the terminal shows up in the UI as a pop-up and a feed row labelled **"terminal / API"**. UI clicks show up in the API and the feed as **"UI"**. The keeper's actions are labelled **"keeper"**.

Optional third pane: `(cd frontend && npm run watch)` prints every on-chain event live (swaps on all three venues, splits, vault moves, parking, λ updates, rebalances, keeper ticks), the same feed as the UI.

Before going on stage: run `./scripts/start_local.sh` (or open the mainnet deployment with `?net=mainnet`), open the UI, `clear` the terminal. The scripted version of every terminal step is `(cd frontend && PAUSE=1 npx tsx scripts/demo.ts)`.

| # | Where | Do | Say |
|---|---|---|---|
| 1 | **UI** | Point at the headline and the two venue cards | "A Partially Active AMM, a 2026 paper, built as a 1inch Aqua position and a Uniswap v4 hook. In any block an arbitrageur can only reach the blue part. The grey part is frozen for the block, and the green part earns in Morpho." |
| 2 | **UI** | Keeper panel: the sentence and the bar chart | "λ isn't a constant. Every ten minutes the keeper replays the last six hours of real ETH prices at this pool's fee and picks the λ that loses least. At 30 bps the same search says 100%: partial activity only helps at low fees. The paper assumes zero fees; we measured it." |
| 3 | **Terminal** | `curl -s "localhost:8788/api/quote?venue=v4&side=buy&usd=10" \| jq .amountOut` then the same with `venue=aqua` | "Same reserves, same λ, same fee: the same price on both venues. It's one kernel." |
| 4 | **Terminal** | `curl -s -X POST "localhost:8788/api/swap?venue=v4&side=buy&usd=10" \| jq '{message,tx}'` | "A real swap through the Uniswap v4 pool. The hook owns the reserves." |
| 5 | **UI** | The pop-up "from terminal / API", then the feed row with that block's split | "The UI saw it: that block's split, with λ and exactly how much was frozen." |
| 6 | **Terminal** | `curl -s -X POST "localhost:8788/api/swap?venue=aqua&side=buy&usd=10" \| jq '{message,tx}'` | "Now 1inch Aqua. The maker holds only Morpho vault shares. The fill withdrew exactly what it needed and the proceeds went straight back in." |
| 7 | **UI** | Feed rows: the Aqua fill plus both vault moves | "Two vault moves, same transaction." |
| 8 | **UI** | Click **Buy ETH on Uniswap v4** and **Sell ETH on 1inch Aqua** | (the feed shows "UI" rows; the terminal can confirm with `curl -s localhost:8788/api/activity \| jq '.items[0]'`) |
| 8b | **Terminal** | `curl -s -X POST "localhost:8788/api/swap?venue=official&side=buy&usd=5" \| jq .message` | "Aqua shared liquidity: the same Morpho balance also backs a plain strategy on 1inch's own unmodified router. One balance, two strategies." |
| 8c | **UI** | Weight tracking card: click **Rebalance now** | "A partially active pool lags the market, so its mix drifts. When it leaves 50% ± 2%, the keeper retires the strategy, rebalances through Uniswap, and re-ships it balanced at the live price, without paying arbitrageurs to do it." (the feed shows retire → Uniswap → re-ship) |
| 9 | **UI** | Replay panel | "The evidence: the real 24 hours of 21 September, replayed minute by minute on a Base fork against a real plain Uniswap v4 pool. Half active cut the LPs' loss 17.6%, λ 39% cut it 19.3%, and the Aqua position lost exactly the same as the hook." |
| 10 | **Terminal** | `(cd frontend && npx tsx scripts/demo.ts) \| tail -8` (steps 6–10) | "A million-dollar order still can't reach the passive side, and the counts on-chain: splits, swaps, vault moves, λ updates." |
| 11 | **UI** | Limitations section | "Honest limits: the gain depends on the fee, the paper's smart λ equals a fixed one in practice, and fewer active reserves means worse prices for ordinary traders, which is why λ has a floor." |

**If something fails live:** the scripted terminal demo prints the same steps with real transactions. The replay numbers come from a committed JSON (`research/replay_2026-09-21_1440min.json`), so the evidence panel never depends on the network.

**Mainnet:** after `CONFIRM=yes ./scripts/deploy_mainnet.sh`, run the keeper with `NETWORK=mainnet` and open `http://localhost:8788/?net=mainnet`. Every transaction hash is in `deployments/mainnet.log`.
