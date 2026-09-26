/* End-to-end check of the running stack: keeper, both venues, API, activity labels, and the UI server. */
import { apiActivity, apiQuote, apiStatus, apiSwap, icebergFor, loadState, rebalanceAqua } from "../lib/server";

const NET = process.env.NETWORK || "local", UI = `http://localhost:${process.env.UI_PORT || 8788}`;
let ok = true;
const check = (name: string, cond: any, detail = "") => { ok &&= !!cond; console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${detail}`); };

(async () => {
  const b = icebergFor(NET);
  const s = await apiStatus(NET);
  const st = loadState(NET), last = st?.events?.at(-1);
  check("keeper is running (ticked in the last 2 minutes)", last && Date.now() / 1000 - last.t < 120, last ? `(${Math.floor(Date.now() / 1000 - last.t)}s ago)` : "");
  check("keeper read live Base Chainlink", last?.live?.ethUsd > 0, `($${last?.live?.ethUsd})`);
  check("keeper derived a fee-aware λ from real prices", last?.policy?.minutes > 60 && last.lambda >= last.policy.floor && last.lambda <= 1, `(λ ${last?.lambda}, ${last?.policy?.minutes} min, floor ${last?.policy?.floor})`);
  const capped = Math.min(last.lambda * 100, s.uniswapV4.maxLambdaPct);
  check("both venues run the keeper's λ (within the shared max-λ cap)", Math.abs(s.uniswapV4.lambdaPct - capped) < 0.01 && Math.abs(s.oneInchAqua.lambdaPct - capped) < 0.01, `(policy ${last.lambda * 100}%, cap ${s.uniswapV4.maxLambdaPct}%, v4 ${s.uniswapV4.lambdaPct}%, Aqua ${s.oneInchAqua.lambdaPct}%)`);
  check("v4 idle reserves earn in Morpho", s.uniswapV4.parkedInMorphoUsd > 0, `($${s.uniswapV4.parkedInMorphoUsd.toFixed(2)})`);
  check("Aqua inventory is held in Morpho vaults", s.oneInchAqua.inMorphoUsd > 0.9 * s.oneInchAqua.totalValueUsd, `($${s.oneInchAqua.inMorphoUsd.toFixed(2)} of $${s.oneInchAqua.totalValueUsd.toFixed(2)})`);
  const [qv, qa] = await Promise.all([apiQuote(NET, "v4", "buy", 5), apiQuote(NET, "aqua", "buy", 5)]);
  check("same trade, same price on both venues (one kernel)", Math.abs(qv.amountOut - qa.amountOut) / qa.amountOut < 1e-5, `(${qv.amountOut} vs ${qa.amountOut})`);
  const before = (await apiActivity(NET)).counts;
  const sv = await apiSwap(NET, "v4", "buy", 5);
  check("API swap through the Uniswap v4 pool", sv.tx && sv.amountOut > 0, `(tx ${sv.tx.slice(0, 12)}…)`);
  const sa = await apiSwap(NET, "aqua", "sell", 5);
  check("API fill on the 1inch Aqua position", sa.tx && sa.amountOut > 0, `(tx ${sa.tx.slice(0, 12)}…)`);
  const after = await apiActivity(NET);
  check("each swap re-split its block on-chain", after.counts.splits >= before.splits + 2, `(${before.splits} -> ${after.counts.splits})`);
  check("Aqua fill moved inventory through Morpho", after.counts.vaultMoves > before.vaultMoves, `(${before.vaultMoves} -> ${after.counts.vaultMoves})`);
  check("activity labels the swaps as coming from terminal / API", after.items.some((i: any) => i.tx === sv.tx && i.source === "terminal / API") && after.items.some((i: any) => i.tx === sa.tx && i.source === "terminal / API"));
  const hs = await b.hookState(), huge = await b.quote("v4", "buy", 10n ** 12n);
  check("passive reserves are out of reach (a $1M buy stays under the active side)", huge < hs.activeWeth, `(${Number(huge) / 1e18} < ${Number(hs.activeWeth) / 1e18} WETH)`);
  const so = await apiSwap(NET, "official", "buy", 3);
  check("shared liquidity: fill on 1inch's official router from the same Morpho balance", so.tx && so.amountOut > 0, `(tx ${so.tx.slice(0, 12)}…)`);
  const oldHash = icebergFor(NET).dep.orderHash;
  const rb = await rebalanceAqua(NET, { force: true });
  check("weight tracking: rebalance retired, traded on Uniswap and re-shipped the Aqua position", rb.rebalanced && rb.newOrderHash && rb.newOrderHash !== oldHash, `(salt ${rb.salt}, ${rb.txs.length} txs)`);
  check("after the rebalance the ETH weight is back at 50%", Math.abs(rb.weightAfter - 0.5) < 0.005, `(${(rb.weightBefore * 100).toFixed(2)}% -> ${(rb.weightAfter * 100).toFixed(2)}%)`);
  const s2 = await apiStatus(NET);
  check("the new strategy carries the keeper's λ", Math.abs(s2.oneInchAqua.lambdaPct - capped) < 0.01, `(${s2.oneInchAqua.lambdaPct}%)`);
  const sa2 = await apiSwap(NET, "aqua", "buy", 3);
  check("fills continue on the re-shipped strategy", sa2.tx && sa2.amountOut > 0, `(tx ${sa2.tx.slice(0, 12)}…)`);
  const q0 = await b.quote("v4", "buy", 10n ** 12n);
  check("v4 hook never quotes more than it can deliver (claims + Morpho withdrawable)", q0 < (await b.hookState()).activeWeth + 1n);
  for (const p of ["/", "/api/status", "/api/replay", "/api/activity"]) { const r = await fetch(UI + p).then(x => x.status).catch(() => 0); check(`UI serves ${p}`, r === 200); }
  console.log(ok ? "END-TO-END: ALL PASS" : "END-TO-END: FAILURES ABOVE");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
