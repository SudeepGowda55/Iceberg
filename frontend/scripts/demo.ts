/* Iceberg terminal demo: the terminal half of the split-screen show. Every step makes real calls / transactions
 * against the running stack and prints what to point at in the UI. PAUSE=1 waits for Enter between steps. */
import readline from "readline";
import { ethers } from "ethers";
import { ABI, fmt } from "../lib/iceberg";
import { apiQuote, apiReplay, apiStatus, apiSwap, icebergFor, feeAwareLambda, loadState, rebalanceAqua, recentPrices } from "../lib/server";

const NET = process.env.NETWORK || "local";
const PAUSE = process.env.PAUSE === "1";
const c = { b: "\x1b[1m", d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", r: "\x1b[0m" };
const step = (n: number, t: string) => console.log(`\n${c.b}${c.c}── ${n}. ${t} ${"─".repeat(Math.max(4, 62 - t.length))}${c.r}`);
const ui = (t: string) => console.log(`  ${c.y}▶ in the UI:${c.r} ${t}`);
const wait = () => PAUSE ? new Promise<void>(r => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(`${c.d}  [Enter]${c.r}`, () => { rl.close(); r(); }); }) : Promise.resolve();

(async () => {
  const b = icebergFor(NET), d = b.dep;
  console.log(`${c.b}Iceberg${c.r} — Partially Active AMM on 1inch Aqua + Uniswap v4 · ${d.mirror ? "local Base fork (real Aqua, v4 PoolManager, Morpho)" : "Base mainnet"}`);

  step(1, "Both venues, live");
  const s = await apiStatus(NET);
  console.log(`  live Base Chainlink ETH/USD $${fmt(s.liveBaseChainlink.ethUsd ?? s.ethUsd)} · block ${s.block}`);
  for (const [name, v] of [["Uniswap v4 hook", s.uniswapV4], ["1inch Aqua     ", s.oneInchAqua]] as const)
    console.log(`  ${name}  λ ${fmt(v.lambdaPct, 0)}% · total $${fmt(v.totalValueUsd)} · ${c.g}active $${fmt(v.activeValueUsd)}${c.r} · in Morpho $${fmt((v as any).parkedInMorphoUsd ?? (v as any).inMorphoUsd)}`);
  ui("the two venue cards: blue = what an arbitrageur can reach this block, grey = frozen passive, green = earning in Morpho");
  await wait();

  step(2, "Why this λ: the keeper is fee-aware");
  const prices = await recentPrices(6);
  const at5 = feeAwareLambda(prices, d.hookFeePips), at30 = feeAwareLambda(prices, 3000);
  console.log(`  last ${at5.minutes} minutes of real ETH/USD (vol ${fmt(at5.volAnnualPct, 0)}%/yr), simulated per λ:`);
  console.log(`   at  5 bps fee → λ ${fmt(at5.lambda * 100, 0)}%  loss ${fmt(at5.bestLossBps, 3)} bps vs ${fmt(at5.plainLossBps, 3)} fully active  (${c.g}${fmt(at5.savedPct, 1)}% saved${c.r})`);
  console.log(`   at 30 bps fee → λ ${fmt(at30.lambda * 100, 0)}%  ${at30.lambda === 1 ? "(partial activity would not help, so it stays fully active)" : `(${fmt(at30.savedPct, 1)}% saved)`}`);
  const st = loadState(NET);
  const last = st?.events?.at(-1);
  if (last) console.log(`  keeper's last tick ${Math.floor(Date.now() / 1000) - last.t}s ago: ${last.actions.map((a: any) => a.what).join("; ") || "no change needed"}`);
  ui("Keeper panel: the bar chart is this exact table; the chosen λ is green");
  await wait();

  step(3, "One kernel, two venues: same trade, same price");
  const [qv, qa] = await Promise.all([apiQuote(NET, "v4", "buy", 10), apiQuote(NET, "aqua", "buy", 10)]);
  console.log(`  buy $10 of ETH on Uniswap v4 hook  → ${fmt(qv.amountOut, 8)} WETH @ $${fmt(qv.price)}`);
  console.log(`  buy $10 of ETH on 1inch Aqua       → ${fmt(qa.amountOut, 8)} WETH @ $${fmt(qa.price)}`);
  console.log(`  difference: ${fmt(Math.abs(qv.amountOut - qa.amountOut) / qa.amountOut * 1e6, 3)} parts per million (same λ, same reserves, same fee)`);
  await wait();

  step(4, "Real swap through the Uniswap v4 pool (hook-owned reserves)");
  const sv = await apiSwap(NET, "v4", "buy", 10);
  console.log(`  ${c.g}${sv.message}${c.r} · tx ${sv.tx} · block ${sv.block}`);
  const split = (await b.hook.queryFilter(b.hook.filters.Split(), sv.block, sv.block))[0] as any;
  if (split) console.log(`  that block's split: λ ${fmt(Number(split.args[1]) / 1e16, 0)}%, passive ${fmt(Number(split.args[2]) / 1e18, 4)} WETH + ${fmt(Number(split.args[3]) / 1e6)} USDC frozen`);
  ui("pop-up \"from terminal / API\", and the activity feed shows the swap and the split");
  await wait();

  step(5, "Real fill on 1inch Aqua (inventory comes out of Morpho, proceeds go back)");
  const sa = await apiSwap(NET, "aqua", "buy", 10);
  console.log(`  ${c.g}${sa.message}${c.r} · tx ${sa.tx}`);
  const uv = await b.vaultHooks.queryFilter(b.vaultHooks.filters.Unvaulted(), sa.block, sa.block), vv = await b.vaultHooks.queryFilter(b.vaultHooks.filters.Vaulted(), sa.block, sa.block);
  for (const e of uv as any[]) console.log(`  withdrew ${fmt(Number(e.args[3]) / 1e18, 6)} WETH from the Moonwell ETH vault for this fill`);
  for (const e of vv as any[]) console.log(`  deposited ${fmt(Number(e.args[3]) / 1e6, 4)} USDC of proceeds into the Steakhouse USDC vault`);
  ui("activity feed: the Aqua fill plus both vault moves, labelled \"terminal / API\"");
  await wait();

  step(6, "The passive part cannot be traded, however big the order");
  const hs = await b.hookState();
  const huge = await b.quote("v4", "buy", 1_000_000n * 10n ** 6n);
  console.log(`  a $1,000,000 buy would get ${fmt(Number(huge) / 1e18, 4)} WETH — capped by the active ${fmt(Number(hs.activeWeth) / 1e18, 4)} WETH; the other ${fmt(Number(hs.totalWeth - hs.activeWeth) / 1e18, 4)} WETH is out of reach this block`);
  await wait();

  step(7, "Evidence: the real 24 hours ending 21 Sep 2026 20:31 UTC");
  const r = apiReplay();
  if (r) {
    const base = r.venues[0].lpLossVsRebalancedUsdc6;
    for (const v of r.venues) console.log(`  ${v.name.padEnd(42)} LP loss $${fmt(v.lpLossVsRebalancedUsdc6 / 1e6, 3)}  ${v === r.venues[0] ? "" : `${c.g}${fmt((1 - v.lpLossVsRebalancedUsdc6 / base) * 100, 1)}% less${c.r}`}`);
    console.log(`  ${c.d}reproduce: REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv${c.r}`);
  }
  ui("Replay panel: same numbers as bars");
  await wait();

  step(8, "Aqua shared liquidity: the same Morpho balance also backs 1inch's official router");
  const so = await apiSwap(NET, "official", "buy", 5);
  console.log(`  ${c.g}${so.message}${c.r} · tx ${so.tx}`);
  console.log(`  one balance, three ways in: the Iceberg Aqua position, this plain strategy on 1inch's unmodified router, and (separately funded) the Uniswap v4 pool`);
  ui("third card + a feed row \"1inch official router (shared liquidity)\" with the vault withdrawal behind it");
  await wait();

  step(9, "Weight tracking: rebalance the Aqua position through Uniswap and re-ship it");
  const rb = await rebalanceAqua(NET, { force: true });
  for (const t of rb.txs) console.log(`  ${t.what} · ${c.d}tx ${t.tx.slice(0, 18)}…${c.r}`);
  console.log(`  ETH weight ${fmt(rb.weightBefore * 100, 2)}% → ${c.g}${fmt(rb.weightAfter * 100, 2)}%${c.r} · new strategy ${rb.newOrderHash.slice(0, 12)}… (salt ${rb.salt})`);
  const after = await apiSwap(NET, "aqua", "buy", 5);
  console.log(`  fills continue on the new strategy: ${after.message} · tx ${after.tx.slice(0, 18)}…`);
  ui("Weight tracking card: count and salt go up; the feed shows retire → Uniswap → re-ship");
  await wait();

  step(10, "Idle reserves earn in Morpho, the keeper keeps the active part in the pool");
  const h2 = await b.hookState();
  console.log(`  v4 pool: ${fmt(Number(h2.inPoolWeth) / 1e18, 4)} WETH in the pool, ${fmt(Number(h2.parkedWeth) / 1e18, 4)} WETH in Moonwell ETH · max λ ${fmt(Number(h2.maxLambdaWad) / 1e16, 0)}% so parking can never starve a block's active share`);
  const counts = (await b.activity(d.deployBlock || 0, {})).counts;
  console.log(`  on-chain so far: ${counts.splits} splits, ${counts.v4Swaps} v4 swaps, ${counts.aquaSwaps} Aqua fills, ${counts.vaultMoves} vault moves, ${counts.parks} park/unpark, ${counts.lambdaUpdates} λ updates`);
  console.log(`\n${c.b}${c.g}Done.${c.r} UI http://localhost:8788/  ·  API curl -s localhost:8788/api/status | jq`);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
