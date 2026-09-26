// Server-side helpers for the API routes, the keeper, the terminal demo and the end-to-end check.
import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { ABI, Iceberg, Venue, WAD, fmt } from "./iceberg";

export const ROOT = process.env.WI_ROOT || path.resolve(process.cwd(), process.cwd().endsWith("frontend") ? ".." : ".");
export const DEPLOYMENTS = path.join(ROOT, "deployments");
const RUN = path.join(ROOT, ".run");

export function loadDep(net = "local") { return JSON.parse(fs.readFileSync(path.join(DEPLOYMENTS, `${net}.json`), "utf8")); }
export function loadState(net = "local") { const p = path.join(DEPLOYMENTS, `${net}.state.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; }
export function saveState(net: string, st: any) { fs.writeFileSync(path.join(DEPLOYMENTS, `${net}.state.json`), JSON.stringify(st, null, 1)); }
/** Deployment plus the keeper's current Aqua strategy (the keeper re-ships with a new salt after each rebalance) */
export function currentDep(net = "local") {
  const d = loadDep(net), st = loadState(net);
  if (net === "mainnet" && process.env.BASE_RPC) d.rpc = process.env.BASE_RPC; // private RPC from .env, never stored in deployments/
  if (st?.aqua?.orderHash) { d.orderHash = st.aqua.orderHash; d.salt = st.aqua.salt; }
  d.salt ??= 1;
  return d;
}
export const icebergFor = (net = "local") => new Iceberg(currentDep(net));
export const wallet = (pk: string, b: Iceberg) => new ethers.NonceManager(new ethers.Wallet(pk, b.provider));

/** address -> who, for activity labels */
export function labels(dep: any): Record<string, string> {
  const m: Record<string, string> = {};
  const k = dep.keys || {};
  const add = (pk: string | undefined, name: string) => { if (pk) m[new ethers.Wallet(pk).address.toLowerCase()] = name; };
  add(k.maker, "keeper"); add(k.trader, "arbitrageur (simulated)"); add(k.ui, "UI"); add(k.cli, "terminal / API");
  if (dep.maker && !m[dep.maker.toLowerCase()]) m[dep.maker.toLowerCase()] = "maker / keeper";
  return m;
}

// ------------------------------------------------------------------------------------------------ live market

const LIVE_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const LIVE_RPCS = [process.env.LIVE_RPC || process.env.BASE_RPC || "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"];
/** Live Base mainnet Chainlink ETH/USD, rotating across public RPCs because free endpoints rate-limit */
export async function liveMarket() {
  let last: any;
  for (let i = 0; i < 8; i++) {
    try {
      const p = new ethers.JsonRpcProvider(LIVE_RPCS[i % LIVE_RPCS.length], 8453, { staticNetwork: true });
      const r = await new ethers.Contract(LIVE_FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p).latestRoundData();
      return { eth8: BigInt(r[1]), eth: Number(r[1]) / 1e8, ageSeconds: Math.floor(Date.now() / 1000) - Number(r[3]) };
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

/** Recent real ETH/USD 1-minute closes from Coinbase, cached for 10 minutes */
export async function recentPrices(hours = 6): Promise<number[]> {
  const cache = path.join(RUN, `candles_${hours}h.json`);
  try { const c = JSON.parse(fs.readFileSync(cache, "utf8")); if (Date.now() - c.at < 600_000) return c.prices; } catch {}
  const end = Math.floor(Date.now() / 60_000) * 60, out: number[][] = [];
  for (let t = end - hours * 3600; t < end; t += 300 * 60) {
    const s = new Date(t * 1000).toISOString(), e = new Date(Math.min(t + 300 * 60, end) * 1000).toISOString();
    for (let i = 0; i < 3; i++) {
      try { const r = await (await fetch(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=${s}&end=${e}`, { headers: { "User-Agent": "iceberg" } })).json(); if (Array.isArray(r)) { out.push(...r); break; } } catch {}
      await new Promise(x => setTimeout(x, 500));
    }
  }
  const prices = [...new Map(out.map(c => [c[0], c[4]])).entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
  if (prices.length > 30) { fs.mkdirSync(RUN, { recursive: true }); fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), prices })); }
  return prices;
}

// ------------------------------------------------------------------------------------------------ fee-aware λ

/** PA-AMM (Algorithm 1) on a 50/50 constant-product pool arbitraged to each price with a fee on the input.
 *  Returns the LP's loss versus a costlessly rebalanced 50/50 portfolio, in basis points of the starting value. */
export function simulateLoss(prices: number[], lambda: number, feePips: number) {
  const f = feePips / 1e6;
  let X = 50_000 / prices[0], Y = 50_000, bench = 100_000, te = 0;
  for (let n = 1; n < prices.length; n++) {
    const s = prices[n]; bench *= 0.5 * s / prices[n - 1] + 0.5;
    let ax = lambda * X, ay = lambda * Y; const px = X - ax, py = Y - ay, k = ax * ay, p = ay / ax;
    if (p < s * (1 - f)) { const pn = s * (1 - f), dyE = Math.sqrt(k * pn) - ay; ax = Math.sqrt(k / pn); ay += dyE / (1 - f); }
    else if (p > s / (1 - f)) { const pn = s / (1 - f), axE = Math.sqrt(k / pn); ay = Math.sqrt(k * pn); ax += (axE - ax) / (1 - f); }
    X = ax + px; Y = ay + py; const w = X * s / (X * s + Y); te += (w - 0.5) ** 2;
  }
  return { lossBps: (bench - (X * prices.at(-1)! + Y)) / bench * 1e4, trackingError: te / prices.length };
}

/** The keeper's policy: on the last hours of real prices, at this pool's fee, pick the λ with the lowest LP loss,
 *  never below `floor` (the maker's service floor: fewer active reserves also means worse prices for ordinary traders).
 *  At high fees this returns λ = 1 (partial activity would hurt), which is the point of making it fee-aware. */
export function feeAwareLambda(prices: number[], feePips: number, floor = Number(process.env.KEEPER_MIN_LAMBDA || 0.4)) {
  const table = [];
  for (let l = 1.0; l >= floor - 1e-9; l -= 0.05) table.push({ lambda: Math.round(l * 100) / 100, ...simulateLoss(prices, l, feePips) });
  const plain = table[0];
  const best = table.reduce((b, r) => (r.lossBps < b.lossBps - 1e-9 ? r : b), plain);
  const r = prices.slice(1).map((v, i) => Math.log(v / prices[i])), sd = Math.sqrt(r.reduce((a, x) => a + x * x, 0) / Math.max(r.length, 1));
  return { lambda: best.lambda, savedPct: plain.lossBps > 0 ? (1 - best.lossBps / plain.lossBps) * 100 : 0, plainLossBps: plain.lossBps, bestLossBps: best.lossBps,
    volAnnualPct: sd * Math.sqrt(525_600) * 100, minutes: prices.length, feeBps: feePips / 100, floor, table: table.map(t => ({ lambda: t.lambda, lossBps: Math.round(t.lossBps * 1000) / 1000 })) };
}

// ------------------------------------------------------------------------------------------------ API

const u6 = (x: bigint) => Number(x) / 1e6, u18 = (x: bigint) => Number(x) / 1e18;

export async function apiStatus(net: string) {
  const b = icebergFor(net), d = b.dep;
  const m = await b.market();
  const [aqua, hook, shared] = await Promise.all([b.aquaState(m.block), b.hookState(), b.sharedState()]);
  const st = loadState(net);
  let live: any; try { const l = await liveMarket(); live = { ethUsd: l.eth, ageSeconds: l.ageSeconds }; } catch (e: any) { live = { error: e.message }; }
  const val = (w: bigint, u: bigint) => u18(w) * m.ethUsd + u6(u);
  return {
    network: d.network, block: m.block, ethUsd: m.ethUsd, oracleAgeSeconds: m.ageSeconds, liveBaseChainlink: live, mirror: !!d.mirror,
    uniswapV4: { hook: d.hook, poolId: d.poolId, feeBps: d.hookFeePips / 100, lambdaPct: Number(hook.lambdaWad) / 1e16, maxLambdaPct: Number(hook.maxLambdaWad) / 1e16,
      totalValueUsd: val(hook.totalWeth, hook.totalUsdc), activeValueUsd: val(hook.activeWeth, hook.activeUsdc), parkedInMorphoUsd: val(hook.parkedWeth, hook.parkedUsdc),
      reserves: { weth: u18(hook.totalWeth), usdc: u6(hook.totalUsdc) }, active: { weth: u18(hook.activeWeth), usdc: u6(hook.activeUsdc) },
      inPool: { weth: u18(hook.inPoolWeth), usdc: u6(hook.inPoolUsdc) }, parked: { weth: u18(hook.parkedWeth), usdc: u6(hook.parkedUsdc) }, lastSplitBlock: hook.lastSplitBlock },
    oneInchAqua: { router: d.router, orderHash: d.orderHash, feeBps: d.aquaFeeBps, lambdaPct: Number(aqua.lambdaWad) / 1e16,
      totalValueUsd: val(aqua.totalWeth, aqua.totalUsdc), activeValueUsd: val(aqua.activeWeth, aqua.activeUsdc), inMorphoUsd: val(aqua.inVaultWeth, aqua.inVaultUsdc),
      balances: { weth: u18(aqua.totalWeth), usdc: u6(aqua.totalUsdc) }, active: { weth: u18(aqua.activeWeth), usdc: u6(aqua.activeUsdc) },
      inMorpho: { weth: u18(aqua.inVaultWeth), usdc: u6(aqua.inVaultUsdc) }, lastSplitBlock: aqua.lastSplitBlock },
    sharedLiquidity: shared ? { router: d.officialRouter, orderHash: d.sharedOrderHash, valueUsd: val(shared.weth, shared.usdc), balances: { weth: u18(shared.weth), usdc: u6(shared.usdc) },
      note: "same Morpho vault shares as the Iceberg position; Aqua lets one balance back both strategies" } : null,
    rebalance: { lastAt: st?.aqua?.rebalancedAt ?? null, count: st?.aqua?.history ? st.aqua.history.length - 1 : 0, salt: d.salt, weightEthPct: aqua.totalWeth > 0n ? u18(aqua.totalWeth) * m.ethUsd / val(aqua.totalWeth, aqua.totalUsdc) * 100 : null, bandPct: Number(process.env.REBALANCE_BAND || 0.02) * 100 },
    keeper: st?.events?.[st.events.length - 1] ?? null, keeperUpdated: st?.updated ?? null,
  };
}

const VENUE_NAME: Record<Venue, string> = { v4: "Uniswap v4 hook", aqua: "1inch Aqua", official: "1inch official router (shared liquidity)" };
export async function apiQuote(net: string, venue: Venue, side: "buy" | "sell", usd: number) {
  const b = icebergFor(net), m = await b.market();
  const amountIn = side === "buy" ? BigInt(Math.round(usd * 1e6)) : BigInt(Math.round(usd / m.ethUsd * 1e18));
  const taker = b.dep.keys?.cli ? new ethers.Wallet(b.dep.keys.cli).address : b.dep.maker;
  const out = await b.quote(venue, side, amountIn, taker);
  const outNum = side === "buy" ? u18(out) : u6(out), inNum = side === "buy" ? u6(amountIn) : u18(amountIn);
  const price = side === "buy" ? inNum / outNum : outNum / inNum;
  return { venue: VENUE_NAME[venue], side, usd, amountIn: inNum, tokenIn: side === "buy" ? "USDC" : "WETH", amountOut: outNum, tokenOut: side === "buy" ? "WETH" : "USDC",
    price, oracle: m.ethUsd, costBps: side === "buy" ? (price / m.ethUsd - 1) * 1e4 : (1 - price / m.ethUsd) * 1e4 };
}

export async function apiSwap(net: string, venue: Venue, side: "buy" | "sell", usd: number, who: "cli" | "ui" = "cli") {
  const b = icebergFor(net), pk = b.dep.keys?.[who];
  if (!pk) throw new Error("swaps via the API are only enabled on the local fork");
  const q = await apiQuote(net, venue, side, usd);
  const amountIn = side === "buy" ? BigInt(Math.round(usd * 1e6)) : BigInt(Math.round(q.amountIn * 1e18));
  // one retry: the gas estimate can race with a keeper transaction landing in the same moment on the fork
  let rc: any;
  for (let i = 0; ; i++) {
    try { rc = await (await b.swapTx(wallet(pk, b), venue, side, amountIn)).wait(); break; }
    catch (e) { if (i >= 1) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
  return { ...q, tx: rc!.hash, block: rc!.blockNumber, message: `${q.venue}: ${side === "buy" ? "bought" : "sold"} ${fmt(side === "buy" ? q.amountOut : q.amountIn, 5)} WETH for ${fmt(side === "buy" ? q.amountIn : q.amountOut)} USDC` };
}

const cached: Record<string, Iceberg> = {};
export async function apiActivity(net: string) {
  const b = (cached[net] ??= icebergFor(net));
  return b.activity(b.dep.deployBlock || 0, labels(b.dep));
}

export function apiReplay() {
  const p = path.join(ROOT, "research", "replay_2026-09-21_1440min.json");
  if (!fs.existsSync(p)) return null;
  const r = JSON.parse(fs.readFileSync(p, "utf8")), venues = [];
  for (let i = 0; r[`venue${i}`]; i++) venues.push(r[`venue${i}`]);
  return { minutes: r.minutes, startPrice: Number(r.startPrice8) / 1e8, endPrice: Number(r.endPrice8) / 1e8, venues };
}

// ------------------------------------------------------------------------------------------------ maker-key lock

/** One signer at a time for the maker key: the keeper and a manual rebalance (API / CLI / demo) must not interleave
 *  transactions, or their nonces collide mid-rebalance. File lock, re-entrant within a process, stale after 3 minutes. */
let lockDepth = 0;
export async function withMakerLock<T>(fn: () => Promise<T>): Promise<T> {
  const f = path.join(RUN, "maker.lock");
  if (lockDepth === 0) {
    fs.mkdirSync(RUN, { recursive: true });
    for (let i = 0; ; i++) {
      try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); break; }
      catch {
        try { if (Date.now() - fs.statSync(f).mtimeMs > 180_000) { fs.rmSync(f); continue; } } catch {}
        if (i > 600) throw new Error("maker key busy (keeper transaction in flight)");
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
  lockDepth++;
  try { return await fn(); }
  finally { if (--lockDepth === 0) { try { fs.rmSync(f); } catch {} } }
}

// ------------------------------------------------------------------------------------------------ rebalancing

const V3_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // Uniswap v3 SwapRouter02 on Base, WETH/USDC 0.05%

/** Weight tracking (the PA-AMM's cost, and WalletIndex's idea): when the Aqua position's ETH weight at the live price
 *  drifts outside the band, retire the strategy, rebalance the maker's Morpho holdings to 50/50 through Uniswap, and
 *  re-ship with salt + 1 balanced at the live price. This resets a stale curve price without paying arbitrageurs. */
export async function rebalanceAqua(net: string, opts: { force?: boolean; band?: number; pk?: string; lambdaWad?: bigint } = {}) {
  return withMakerLock(() => rebalanceAquaUnlocked(net, opts));
}
async function rebalanceAquaUnlocked(net: string, opts: { force?: boolean; band?: number; pk?: string; lambdaWad?: bigint }) {
  const b = icebergFor(net), d = b.dep;
  const pk = opts.pk || d.keys?.maker || process.env.DEPLOYER_PK;
  if (!pk) throw new Error("rebalancing needs the maker key (DEPLOYER_PK)");
  const band = opts.band ?? Number(process.env.REBALANCE_BAND || 0.02);
  const m = await b.market(), s = m.ethUsd;
  const [[tW], [tU]] = await Promise.all([b.aqua.rawBalances(d.maker, d.router, d.orderHash, d.weth), b.aqua.rawBalances(d.maker, d.router, d.orderHash, d.usdc)]);
  const docked = tW === 0n && tU === 0n;
  const w = docked ? 0.5 : (Number(tW) / 1e18 * s) / (Number(tW) / 1e18 * s + Number(tU) / 1e6);
  const out: any = { weightBefore: w, band, rebalanced: false, txs: [] as any[] };
  if (!opts.force && !docked && Math.abs(w - 0.5) <= band) return { ...out, reason: `ETH weight ${fmt(w * 100, 2)}% is inside 50% ± ${fmt(band * 100, 1)}%` };
  const signer = wallet(pk, b), me = await signer.getAddress();
  const aqua = new ethers.Contract(d.aqua, ABI.aqua, signer), params = new ethers.Contract(d.params, ABI.params, signer);
  const vW = new ethers.Contract(d.vaultWeth, ABI.vault, signer), vU = new ethers.Contract(d.vaultUsdc, ABI.vault, signer);
  const weth = new ethers.Contract(d.weth, ABI.erc20rw, signer), usdc = new ethers.Contract(d.usdc, ABI.erc20rw, signer);
  const v3 = new ethers.Contract(V3_ROUTER, ABI.v3router, signer);
  const tx = async (what: string, p: Promise<any>) => {
    if (process.env.DEBUG) console.log(`  … ${what}`);
    try { const rc = await (await p).wait(); out.txs.push({ what, tx: rc.hash }); return rc; }
    catch (e: any) { throw new Error(`${what}: ${e.shortMessage || e.message}`); }
  };
  // 1. retire the current strategy (resumable: a rebalance interrupted after docking picks up from here)
  const [, cnt] = await b.aqua.rawBalances(d.maker, d.router, d.orderHash, d.weth);
  if (Number(cnt) === 255) out.txs.push({ what: "strategy already retired by an interrupted rebalance: resuming", tx: "" });
  else await tx("retired the Aqua strategy (dock)", aqua.dock(d.router, d.orderHash, [d.weth, d.usdc]));
  // 2. rebalance the maker's Morpho holdings to 50/50 at the live price, trading the excess on Uniswap v3
  const heldW: bigint = await vW.convertToAssets(await vW.balanceOf(me)), heldU: bigint = await vU.convertToAssets(await vU.balanceOf(me));
  const valW = Number(heldW) / 1e18 * s, valU = Number(heldU) / 1e6, half = (valW + valU) / 2;
  if (valW > half) {
    const sellW = BigInt(Math.floor((valW - half) / s * 1e18));
    await tx(`withdrew ${fmt(Number(sellW) / 1e18, 5)} WETH from Morpho`, vW.withdraw(sellW, me, me));
    if ((await weth.allowance(me, V3_ROUTER)) < sellW) await tx("approve WETH for Uniswap", weth.approve(V3_ROUTER, ethers.MaxUint256));
    const u0: bigint = await usdc.balanceOf(me);
    await tx(`sold ${fmt(Number(sellW) / 1e18, 5)} WETH on Uniswap v3 (0.05%)`, v3.exactInputSingle([d.weth, d.usdc, 500, me, sellW, BigInt(Math.floor((valW - half) * 0.98 * 1e6)), 0]));
    const got: bigint = (await usdc.balanceOf(me)) - u0;
    if ((await usdc.allowance(me, d.vaultUsdc)) < got) await tx("approve USDC for Morpho", usdc.approve(d.vaultUsdc, ethers.MaxUint256));
    await tx(`deposited ${fmt(Number(got) / 1e6)} USDC into Morpho`, vU.deposit(got, me));
  } else if (valU > half) {
    const sellU = BigInt(Math.floor((valU - half) * 1e6));
    await tx(`withdrew ${fmt(Number(sellU) / 1e6)} USDC from Morpho`, vU.withdraw(sellU, me, me));
    if ((await usdc.allowance(me, V3_ROUTER)) < sellU) await tx("approve USDC for Uniswap", usdc.approve(V3_ROUTER, ethers.MaxUint256));
    const w0: bigint = await weth.balanceOf(me);
    await tx(`bought WETH with ${fmt(Number(sellU) / 1e6)} USDC on Uniswap v3 (0.05%)`, v3.exactInputSingle([d.usdc, d.weth, 500, me, sellU, BigInt(Math.floor((valU - half) / s * 0.98 * 1e18)), 0]));
    const got: bigint = (await weth.balanceOf(me)) - w0;
    if ((await weth.allowance(me, d.vaultWeth)) < got) await tx("approve WETH for Morpho", weth.approve(d.vaultWeth, ethers.MaxUint256));
    await tx(`deposited ${fmt(Number(got) / 1e18, 5)} WETH into Morpho`, vW.deposit(got, me));
  }
  // 3. re-ship with salt + 1, balances = the rebalanced Morpho holdings, and carry λ over to the new strategy
  const salt = Number(d.salt ?? 1) + 1;
  const o = await b.lens.order(d.maker, d.hooks, d.params, d.feed, salt);
  const nW: bigint = await vW.convertToAssets(await vW.balanceOf(me)), nU: bigint = await vU.convertToAssets(await vU.balanceOf(me));
  const strategy = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address maker, uint256 traits, bytes data)"], [[o[0], o[1], o[2]]]);
  const rc = await tx(`re-shipped the position balanced at $${fmt(s)} (salt ${salt})`, aqua.ship(d.router, strategy, [d.weth, d.usdc], [nW, nU]));
  const newHash = rc.logs.map((l: any) => { try { return b.aqua.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Shipped")?.args[2];
  const cur = await b.params.get(d.maker, d.orderHash);
  const lam = opts.lambdaWad ?? (cur[2] ? BigInt(cur[0]) : 5n * 10n ** 17n);
  await tx(`λ ${fmt(Number(lam) / 1e16, 0)}% carried to the new strategy`, params.setLambda(d.maker, newHash, lam, 0));
  const st = loadState(net) || { events: [] };
  const hist = st.aqua?.history || [d.orderHash];
  st.aqua = { orderHash: newHash, salt, rebalancedAt: Math.floor(Date.now() / 1000), history: [...hist, newHash] };
  saveState(net, st);
  const wAfter = (Number(nW) / 1e18 * s) / (Number(nW) / 1e18 * s + Number(nU) / 1e6);
  return { ...out, rebalanced: true, weightAfter: wAfter, newOrderHash: newHash, salt };
}
