/* Iceberg keeper: live price -> fee-aware λ for both venues -> keep idle v4 reserves parked in Morpho.
 * On the local fork it also mirrors the live Base Chainlink answer into the fork's MirrorFeed and runs a clearly
 * labelled simulated arbitrageur so the pools see realistic flow. Runs on its own timer; every decision is logged. */
import { ethers } from "ethers";
import { ABI, WAD, fmt, splitActive } from "../lib/iceberg";
import { icebergFor, feeAwareLambda, liveMarket, loadState, rebalanceAqua, recentPrices, saveState, wallet, withMakerLock } from "../lib/server";

const NET = process.env.NETWORK || "local";
const INTERVAL = Number(process.env.INTERVAL || 20) * 1000;
const TICKS = Number(process.argv[2] || Infinity);
const FORCE_LAMBDA = process.env.FORCE_LAMBDA ? Number(process.env.FORCE_LAMBDA) : null; // demo override
let b = icebergFor(NET), d = b.dep;
const keeperPk = d.keys?.maker || process.env.DEPLOYER_PK;
if (!keeperPk) throw new Error("no keeper key: set DEPLOYER_PK");
const keeper = wallet(keeperPk, b);
const trader = d.keys?.trader ? wallet(d.keys.trader, b) : null;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function publishLambda(lambda: number, ev: any) {
  const params = new ethers.Contract(d.params, ABI.params, keeper);
  const want = BigInt(Math.round(lambda * 1e4)) * 10n ** 14n;
  // the Aqua position is keyed by (maker, order hash); the v4 pool by (hook, pool id): the hook is its own maker
  for (const [maker, id, name] of [[d.maker, d.orderHash, "1inch Aqua position"], [d.hook, d.poolId, "Uniswap v4 pool"]] as const) {
    try {
      // clamp to this venue's own box (the v4 pool caps λ at max λ, the guarantee that parked reserves are never needed)
      const [, lo, hi] = await b.params.config(maker);
      let v = want;
      if (BigInt(hi) > 0n && v > BigInt(hi)) v = BigInt(hi);
      if (v < BigInt(lo)) v = BigInt(lo);
      const cur = await b.params.get(maker, id);
      if (cur[2] && BigInt(cur[0]) === v) continue;
      const rc = await (await params.setLambda(maker, id, v, 0)).wait();
      ev.actions.push({ what: `λ = ${fmt(Number(v) / 1e16, 0)}% published for the ${name}${v !== want ? ` (its cap; policy wanted ${fmt(lambda * 100, 0)}%)` : ""}`, tx: rc!.hash });
    } catch (e: any) { keeper.reset(); ev.actions.push({ what: `could not publish λ for the ${name}: ${e.shortMessage || e.message}` }); } // never abort the tick
  }
}

/** Keep the v4 pool's in-pool claims between maxλ·R and maxλ·R + 2%; everything else earns in Morpho */
async function maintainParking(ev: any) {
  const h = await b.hookState();
  const hook = new ethers.Contract(d.hook, ABI.hook, keeper);
  for (const side of [0, 1] as const) {
    const total = side === 0 ? h.totalWeth : h.totalUsdc, inPool = side === 0 ? h.inPoolWeth : h.inPoolUsdc;
    const keep = (total * h.maxLambdaWad) / WAD, upper = (total * (h.maxLambdaWad + 2n * 10n ** 16n)) / WAD;
    const name = side === 0 ? "WETH" : "USDC", dec = side === 0 ? 1e18 : 1e6;
    if (inPool < keep) {
      const rc = await (await hook.unpark(side, keep - inPool + 1n)).wait();
      ev.actions.push({ what: `unparked ${fmt(Number(keep - inPool) / dec, 4)} ${name} from Morpho (active share could exceed what is in the pool)`, tx: rc!.hash });
    } else if (inPool > upper) {
      const amt = ((inPool - keep) * 99n) / 100n;
      const rc = await (await hook.park(side, amt)).wait();
      ev.actions.push({ what: `parked ${fmt(Number(amt) / dec, 4)} idle ${name} in Morpho`, tx: rc!.hash });
    }
  }
}

/** Local fork only: a rational arbitrageur trades each venue's active curve to the live price (labelled as simulated) */
async function simulatedArbitrage(eth8: bigint, ev: any) {
  if (!trader) return;
  const block = await b.provider.getBlockNumber();
  const venues: [string, bigint, bigint, bigint][] = [];
  const h = await b.hookState(); venues.push(["v4", h.activeWeth, h.activeUsdc, BigInt(d.hookFeePips)]);
  const a = await b.aquaState(block); venues.push(["aqua", a.activeWeth, a.activeUsdc, BigInt(d.aquaFeeBps) * 100n]);
  const sh = await b.sharedState(); if (sh) venues.push(["official", sh.weth, sh.usdc, BigInt(d.aquaFeeBps) * 100n]); // plain curve: fully active
  for (const [venue, aW, aU, fee] of venues) {
    const s = Number(eth8) / 1e8, p = (Number(aU) / 1e6) / (Number(aW) / 1e18), f = Number(fee) / 1e6, k = Number(aW) / 1e18 * Number(aU) / 1e6;
    let side: "buy" | "sell" | null = null, amt = 0n;
    if (p < s * (1 - f)) { const newU = Math.sqrt(k * s * (1 - f)); side = "buy"; amt = BigInt(Math.floor((newU - Number(aU) / 1e6) / (1 - f) * 1e6 * 0.98)); }
    else if (p > s / (1 - f)) { const newW = Math.sqrt(k / (s / (1 - f))); side = "sell"; amt = BigInt(Math.floor((newW - Number(aW) / 1e18) / (1 - f) * 1e18 * 0.98)); }
    const notionalUsd = side === "buy" ? Number(amt) / 1e6 : Number(amt) / 1e18 * s;
    if (!side || amt <= 0n || notionalUsd < Number(process.env.MIN_ARB_USD || 1)) continue; // skip dust at the edge of profitability
    try {
      const rc = await (await b.swapTx(trader, venue as any, side, amt)).wait();
      ev.arbs.push({ venue: venue === "v4" ? "Uniswap v4 hook" : venue === "official" ? "1inch official router (shared)" : "1inch Aqua", side, amountIn: side === "buy" ? Number(amt) / 1e6 : Number(amt) / 1e18, poolPrice: p, livePrice: s, tx: rc!.hash });
    } catch (e: any) { trader.reset(); ev.arbs.push({ venue, error: e.shortMessage || e.message }); }
  }
}

async function tick(n: number, st: any, policyEvery: number) {
  b = icebergFor(NET); d = b.dep; // follow the current Aqua strategy (a rebalance re-ships it with a new salt)
  const ev: any = { t: Math.floor(Date.now() / 1000), tick: n, actions: [], arbs: [] };
  const live = await liveMarket(); ev.live = { ethUsd: live.eth, ageSeconds: live.ageSeconds };
  if (d.mirror) {
    const feed = new ethers.Contract(d.feed, ABI.feed, keeper);
    await (await feed.push(live.eth8)).wait();
    ev.actions.push({ what: `mirrored live Base Chainlink ETH/USD $${fmt(live.eth)} into the fork's MirrorFeed` });
  }
  if (n % policyEvery === 0 || !st.policy) {
    const prices = await recentPrices(6);
    if (prices.length > 60) st.policy = feeAwareLambda(prices, d.hookFeePips);
  }
  if (st.policy) {
    ev.policy = st.policy;
    const lambda = FORCE_LAMBDA ?? st.policy.lambda;
    ev.lambda = lambda;
    await publishLambda(lambda, ev);
  }
  await maintainParking(ev);
  const rb = await rebalanceAqua(NET, { pk: keeperPk });
  if (rb.rebalanced) {
    ev.rebalance = rb; st.aqua = loadState(NET)?.aqua; b = icebergFor(NET); d = b.dep;
    ev.actions.push({ what: `rebalanced the Aqua position: ETH weight ${fmt(rb.weightBefore * 100, 2)}% → ${fmt(rb.weightAfter * 100, 2)}% at the live price (salt ${rb.salt})`, tx: rb.txs.at(-2)?.tx });
  } else ev.weightEthPct = rb.weightBefore * 100;
  if (NET === "local" && process.env.SIM_ARB !== "0") await simulatedArbitrage(live.eth8, ev);
  const why = st.policy ? `last ${st.policy.minutes} min of real ETH/USD at ${st.policy.feeBps} bps: λ ${fmt(ev.lambda * 100, 0)}% loses ${fmt(st.policy.bestLossBps, 3)} bps vs ${fmt(st.policy.plainLossBps, 3)} bps fully active (${fmt(st.policy.savedPct, 1)}% saved)` : "waiting for price history";
  console.log(`[tick ${n}] live ETH $${fmt(live.eth)} | ${why}`);
  for (const a of ev.actions) console.log(`   ${a.what}${a.tx ? ` · tx ${a.tx.slice(0, 12)}…` : ""}`);
  for (const a of ev.arbs) console.log(`   simulated arbitrageur: ${a.error ? a.error : `${a.side} on ${a.venue} (pool $${fmt(a.poolPrice)} vs live $${fmt(a.livePrice)})`}`);
  const disk = loadState(NET); if (disk?.aqua) st.aqua = disk.aqua;
  st.events = [...(st.events || []), ev].slice(-200); st.updated = ev.t;
  saveState(NET, st);
}

(async () => {
  const st = loadState(NET) || { events: [] };
  const policyEvery = Math.max(1, Math.round(600_000 / INTERVAL)); // re-derive λ from fresh history every ~10 minutes
  for (let n = 0; n < TICKS; n++) {
    try { await withMakerLock(() => tick(n, st, policyEvery)); } catch (e: any) { keeper.reset(); console.log(`[tick ${n}] error, retrying next tick: ${e.shortMessage || e.message}${process.env.DEBUG ? "\n" + (e.stack || "").split("\n").slice(0, 6).join("\n") : ""}`); }
    if (n + 1 < TICKS) await sleep(INTERVAL);
  }
})();
