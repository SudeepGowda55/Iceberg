"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart } from "@/components/Charts";
import { Reveal, SplitText, Tween } from "@/components/fx";
import { Footer } from "@/components/Shell";
import { fmt, short, usd0 } from "@/lib/ui";

type Toast = { id: number; text: string; src: string };
const NETQ = () => (typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("net") || "local");
const withNet = (p: string) => `${p}${p.includes("?") ? "&" : "?"}net=${NETQ()}`;
const srcClass = (s: string) => (s === "terminal / API" ? "src-cli" : s === "UI" ? "src-ui" : s === "keeper" || s === "maker / keeper" ? "src-agent" : "");
const SPRING = { type: "spring" as const, stiffness: 120, damping: 20 };

const Stack = ({ active, passive, parked }: { active: number; passive: number; parked: number }) => {
  const tot = active + passive + parked || 1;
  return <div className="vstack" role="img" aria-label={`active ${fmt(active / tot * 100, 0)}%, passive ${fmt(passive / tot * 100, 0)}%, in Morpho ${fmt(parked / tot * 100, 0)}%`}>
    <motion.div className="s-active" initial={{ width: 0 }} animate={{ width: `${active / tot * 100}%` }} transition={SPRING} />
    <motion.div className="s-frozen" initial={{ width: 0 }} animate={{ width: `${passive / tot * 100}%` }} transition={SPRING} />
    <motion.div className="s-morpho" initial={{ width: 0 }} animate={{ width: `${parked / tot * 100}%` }} transition={SPRING} />
  </div>;
};

export default function Dashboard() {
  const [st, setSt] = useState<any>(null);
  const [act, setAct] = useState<any>({ items: [], counts: {} });
  const [replay, setReplay] = useState<any>(null);
  const [err, setErr] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tradeMsg, setTradeMsg] = useState<any>("");
  const [apiOut, setApiOut] = useState("");
  const [usd, setUsd] = useState(25);
  const [rbMsg, setRbMsg] = useState<any>("");
  const seen = useRef(new Set<string>()), first = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([fetch(withNet("/api/status")).then(r => r.json()), fetch(withNet("/api/activity")).then(r => r.json())]);
      if (s.error) throw new Error(s.error);
      setSt(s); setErr("");
      if (!a.error) {
        const fresh: any[] = [];
        for (const i of a.items) if (!seen.current.has(i.key)) { if (!first.current) { i.isNew = true; fresh.push(i); } seen.current.add(i.key); }
        first.current = false;
        setAct(a);
        for (const f of fresh.filter(x => (x.source === "terminal / API" || x.source === "keeper") && x.kind !== "split").slice(0, 3)) {
          const id = Math.random();
          setToasts(t => [...t, { id, text: f.text, src: f.source }]);
          setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 9000);
        }
      }
    } catch (e: any) { setErr(`cannot reach the Iceberg stack (${e.message}) — run ./scripts/start_local.sh`); }
  }, []);

  useEffect(() => { refresh(); fetch("/api/replay").then(r => r.json()).then(setReplay).catch(() => {}); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  const VN: Record<string, string> = { v4: "Uniswap v4 hook", aqua: "1inch Aqua position", official: "1inch official router (shared liquidity)" };
  const trade = async (venue: "v4" | "aqua" | "official", side: "buy" | "sell") => {
    setTradeMsg(`sending a real ${side} of $${usd} to the ${VN[venue]}…`);
    const r = await fetch(withNet(`/api/swap?venue=${venue}&side=${side}&usd=${usd}&who=ui`), { method: "POST" }).then(x => x.json());
    setTradeMsg(r.error ? <span className="bad">{r.error}</span> : <span className="good">{r.message} · price ${fmt(r.price)} vs oracle ${fmt(r.oracle)} ({r.costBps >= 0 ? `${fmt(r.costBps, 1)} bps cost` : `${fmt(-r.costBps, 1)} bps better than oracle`}) · tx {short(r.tx)}</span>);
    refresh();
  };
  const call = async (path: string, method = "GET") => {
    setApiOut("…");
    const r = await fetch(withNet(path), { method }).then(x => x.json()).catch(e => ({ error: String(e) }));
    setApiOut(JSON.stringify(r, null, 2));
    if (method === "POST") refresh();
  };

  // real money on mainnet (and ~$1 positions): start the trade size at 1 cent
  useEffect(() => { if (st?.network === "mainnet") setUsd(x => (x > 1 ? 0.01 : x)); }, [st?.network]);
  const u = st?.uniswapV4, a = st?.oneInchAqua, sh = st?.sharedLiquidity, rb = st?.rebalance, k = st?.keeper, pol = k?.policy;
  const rebalance = async () => {
    setRbMsg("retiring the strategy, rebalancing through Uniswap, re-shipping…");
    const r = await fetch(withNet("/api/rebalance?force=1"), { method: "POST" }).then(x => x.json());
    setRbMsg(r.error ? <span className="bad">{r.error}</span> : <span className="good">ETH weight {fmt(r.weightBefore * 100, 2)}% → {fmt(r.weightAfter * 100, 2)}% · {r.txs.length} transactions · new strategy {short(r.newOrderHash)} (salt {r.salt})</span>);
    refresh();
  };
  const best = replay?.venues?.reduce((b: any, v: any) => (!b || v.lpLossVsRebalancedUsdc6 < b.lpLossVsRebalancedUsdc6 ? v : b), null);
  const plain = replay?.venues?.[0];
  const savedPct = plain && best ? (1 - best.lpLossVsRebalancedUsdc6 / plain.lpLossVsRebalancedUsdc6) * 100 : null;
  const half = replay?.venues?.find((v: any) => v.name.includes("hook, lambda 50%"));
  const halfPct = plain && half ? (1 - half.lpLossVsRebalancedUsdc6 / plain.lpLossVsRebalancedUsdc6) * 100 : null;
  const off = !!st?.snapshot;
  const f0 = useCallback((v: number) => usd0(v), []), f2 = useCallback((v: number) => `$${fmt(v)}`, []), fp = useCallback((v: number) => `${fmt(v, 0)}%`, []), fi = useCallback((v: number) => fmt(v, 0), []);

  return <main className="above">
    <section className="phead wrap" id="overview">
      <Reveal><div className="kicker">{err ? "Stack offline" : st ? (st.network === "mainnet" ? "Live · Base mainnet" : "Live · Base fork, official Aqua, v4 PoolManager, Morpho") : "Connecting…"}</div></Reveal>
      <SplitText text="The pool, right now." className="display h-l" />
      <div className="live-top">
        {st && <><span className="chip"><span className="live" />block <Tween value={st.block} format={fi} /></span><span className="chip">ETH <Tween value={st.ethUsd} format={f2} /></span>
          <span className="chip">keeper {st.snapshot ? "snapshot" : st.keeperUpdated ? `${Math.max(0, Math.floor(Date.now() / 1000) - st.keeperUpdated)}s ago` : "–"}</span></>}
        {["venues", "keeper", "replay", "trade", "activity", "api"].map(s => <a key={s} className="chip" href={`#${s}`} style={{ textDecoration: "none" }}>{s[0].toUpperCase() + s.slice(1)} ↓</a>)}
      </div>
      {err && <div className="alert err">{err}</div>}
      {off && <div className="alert info">Read-only snapshot of the live demo, taken at block {st.snapshot.block}. Trading and rebalancing are off on this page.</div>}
      <div className="kpis">
        {[
          { k: "Loss to arbitrage saved, 21 Sep replay", v: savedPct != null ? `${fmt(savedPct, 1)}%` : "–", s: `vs a real plain v4 pool, 1,440 min, 5 bps${halfPct != null ? ` · λ 50%: ${fmt(halfPct, 1)}%` : ""}`, c: "morpho" },
          { k: "λ now (keeper)", v: u ? <Tween value={u.lambdaPct} format={fp} /> : "–", s: pol ? `${fmt(pol.savedPct, 1)}% less loss on the last ${pol.minutes} min` : "waiting for keeper", c: "tip" },
          { k: "Liquidity, both venues", v: st ? <Tween value={u.totalValueUsd + a.totalValueUsd} format={f0} /> : "–", s: `tradable this block: ${st ? usd0(u.activeValueUsd + a.activeValueUsd) : "–"}` },
          { k: "Earning in Morpho", v: st ? <Tween value={u.parkedInMorphoUsd + a.inMorphoUsd} format={f0} /> : "–", s: "Steakhouse USDC · Moonwell ETH vaults", c: "morpho" },
          { k: "Per-block splits on-chain", v: act.counts?.splits != null ? <Tween value={act.counts.splits} format={fi} /> : "–", s: `${act.counts?.v4Swaps ?? 0} v4 swaps · ${act.counts?.aquaSwaps ?? 0} Aqua fills · ${act.counts?.sharedSwaps ?? 0} shared · ${act.counts?.rebalances ?? 0} rebalances` },
          { k: "Live Base Chainlink", v: st?.liveBaseChainlink?.ethUsd ? <Tween value={st.liveBaseChainlink.ethUsd} format={f2} /> : "–", s: "read live" },
        ].map((x, i) => <Reveal key={x.k} delay={i * 0.05} className="kpi glass"><div className="k">{x.k}</div><div className={`v ${x.c ?? ""}`}>{x.v}</div><div className="s">{x.s}</div></Reveal>)}
      </div>
    </section>

    <div className="wrap">
      <section id="venues" className="lsec"><h2>Two venues, one kernel</h2>
        <div className="g2">
          {[["Uniswap v4 hook", u, "uni"], ["1inch Aqua position", a, "aqua"]].map(([name, v, cls]: any) =>
            <Reveal key={name}><div className="panel glass" style={{ height: "100%" }}>
              <h3 className={cls} style={{ fontSize: 22 }}>{name}</h3>
              <div className="t2 mono" style={{ fontSize: 12.5 }}>{v ? (cls === "uni" ? `hook ${short(v.hook)} · pool ${short(v.poolId)} · ${v.feeBps} bps` : `order ${short(v.orderHash)} · ${v.feeBps} bps · inventory in Morpho vaults`) : "–"}</div>
              {v && <>
                <Stack active={v.activeValueUsd} passive={Math.max(0, v.totalValueUsd - v.activeValueUsd - (v.parkedInMorphoUsd ?? 0))} parked={v.parkedInMorphoUsd ?? 0} />
                <div className="legend2"><span><i className="s-active" />active this block {usd0(v.activeValueUsd)}</span><span><i className="s-frozen" />passive (frozen)</span>{cls === "uni" && <span><i className="s-morpho" />parked in Morpho {usd0(v.parkedInMorphoUsd)}</span>}</div>
                <div style={{ marginTop: 12 }}>
                  <div className="kv"><span className="k">λ</span><span className="v">{fmt(v.lambdaPct, 0)}%</span></div>
                  <div className="kv"><span className="k">reserves</span><span className="v">{fmt((v.reserves ?? v.balances).weth, 4)} WETH + {fmt((v.reserves ?? v.balances).usdc)} USDC</span></div>
                  <div className="kv"><span className="k">active (arbitrage can reach)</span><span className="v">{fmt(v.active.weth, 4)} WETH + {fmt(v.active.usdc)} USDC</span></div>
                  {cls === "uni" ? <div className="kv"><span className="k">in pool / in Morpho</span><span className="v">{fmt(v.inPool.weth, 4)} / {fmt(v.parked.weth, 4)} WETH</span></div>
                    : <div className="kv"><span className="k">maker&apos;s Morpho vault balances</span><span className="v">{fmt(v.inMorpho.weth, 4)} WETH + {fmt(v.inMorpho.usdc)} USDC</span></div>}
                  <div className="kv"><span className="k">last split block</span><span className="v">{v.lastSplitBlock || "–"}</span></div>
                </div>
              </>}
            </div></Reveal>)}
          {sh && <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 className="aqua" style={{ fontSize: 22 }}>1inch official router · shared liquidity</h3>
            <div className="t2 mono" style={{ fontSize: 12.5 }}>order {short(sh.orderHash)} · plain 5 bps curve on 1inch&apos;s unmodified router</div>
            <p className="why">The <b>same Morpho vault shares</b> back this strategy and the Iceberg position: Aqua lets one balance serve several strategies, and each fill withdraws exactly what it needs.</p>
            <div className="kv" style={{ marginTop: 12 }}><span className="k">committed from the shared balance</span><span className="v">{fmt(sh.balances.weth, 4)} WETH + {fmt(sh.balances.usdc)} USDC ({usd0(sh.valueUsd)})</span></div>
            <div className="kv"><span className="k">maker&apos;s Morpho balance behind both</span><span className="v">{a ? `${fmt(a.inMorpho.weth, 4)} WETH + ${fmt(a.inMorpho.usdc)} USDC` : "–"}</span></div>
          </div></Reveal>}
          {rb && <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 style={{ fontSize: 22 }}>Weight tracking</h3>
            <p className="why">A partially active pool lags the market, so its mix drifts. When the Aqua position&apos;s ETH weight at the live price leaves 50% ± {fmt(rb.bandPct, 1)}%, the keeper retires it, rebalances the Morpho holdings through Uniswap, and re-ships it balanced. That resets the stale price without paying arbitrageurs.</p>
            <div className="kv" style={{ marginTop: 12 }}><span className="k">ETH weight now</span><span className="v">{rb.weightEthPct != null ? `${fmt(rb.weightEthPct, 2)}%` : "–"}</span></div>
            <div className="kv"><span className="k">rebalances so far</span><span className="v">{rb.count} · strategy salt {rb.salt}</span></div>
            <div className="btnrow"><button id="rebalance" className="lbtn" disabled={off} onClick={rebalance}>Rebalance now</button></div>
            <div className="result" id="rebalance-result">{rbMsg}</div>
          </div></Reveal>}
        </div>
      </section>

      <section id="keeper" className="lsec"><h2>Fee-aware keeper</h2>
        <div className="g2">
          <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 style={{ fontSize: 22 }}>Why λ = <span className="tip">{pol ? `${fmt(k.lambda * 100, 0)}%` : "…"}</span></h3>
            <p className="why">{pol ? <>On the last <b>{pol.minutes}</b> minutes of real ETH/USD (annualised vol {fmt(pol.volAnnualPct, 0)}%) at this pool&apos;s <b>{pol.feeBps} bps</b> fee, exposing {fmt(k.lambda * 100, 0)}% of the reserves loses <b className="good">{fmt(pol.bestLossBps, 3)} bps</b> to arbitrage versus <b>{fmt(pol.plainLossBps, 3)} bps</b> fully active ({fmt(pol.savedPct, 1)}% saved). At high fees the same search returns λ = 100%. λ never goes below the maker&apos;s floor of {fmt(pol.floor * 100, 0)}%, so ordinary traders always find deep liquidity.</> : "the keeper publishes its first decision within a minute"}</p>
            {pol && <><div className="t2" style={{ fontSize: 12, marginTop: 12 }}>loss to arbitrage at each λ, as % of the fully active loss</div>
              <BarChart height={200} vFmt={v => fmt(v, 1) + "%"} bars={pol.table.filter((t: any, i: number) => i % 2 === 0 || t.lambda === k.lambda).map((t: any) => ({ label: `λ ${fmt(t.lambda * 100, 0)}%`, v: t.lossBps / pol.table[0].lossBps * 100, color: t.lambda === k.lambda ? "#3ef0a6" : "#3d6fa8" }))} /></>}
          </div></Reveal>
          <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 style={{ fontSize: 22 }}>Last keeper tick</h3>
            {k ? <div className="feed" style={{ maxHeight: 320 }} data-lenis-prevent>
              <div className="ev">live Base ETH/USD ${fmt(k.live?.ethUsd)} ({k.live?.ageSeconds}s old)</div>
              {k.actions.map((x: any, i: number) => <div key={i} className="ev">{x.what}{x.tx && <span className="muted"> · tx {short(x.tx)}</span>}</div>)}
              {k.arbs.map((x: any, i: number) => <div key={"a" + i} className="ev"><span className="srcpill">simulated arbitrageur</span> {x.error ? x.error : `${x.side} on ${x.venue}: pool $${fmt(x.poolPrice)} → live $${fmt(x.livePrice)}`}</div>)}
            </div> : <div className="empty">no keeper tick yet</div>}
          </div></Reveal>
        </div>
      </section>

      <section id="replay" className="lsec"><h2>Real replay: 24 hours ending 21 Sep 2026 20:31 UTC</h2>
        <div className="g2">
          <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 style={{ fontSize: 20 }}>LP loss versus a perfectly rebalanced portfolio</h3>
            <p className="why">ETH ${replay ? fmt(replay.startPrice) : "…"} → ${replay ? fmt(replay.endPrice) : "…"} (+6.24%). Every minute a rational arbitrageur trades each venue to the real Coinbase close, against the real Uniswap v4 PoolManager and official Aqua on Base. Same 5 bps fee and starting reserves for all.</p>
            {replay && <BarChart height={220} vFmt={v => "$" + fmt(v, 3)} bars={replay.venues.map((v: any, i: number) => ({ label: v.name.includes("plain") ? "plain v4" : (v.name.includes("Aqua") ? "Aqua " : "hook ") + "λ" + Math.round(Number(v.lambdaWad) / 1e16) + "%", v: v.lpLossVsRebalancedUsdc6 / 1e6, color: i === 0 ? "#ff5fa2" : v.name.includes("Aqua") ? "#4fd1db" : v.lambdaWad === "1000000000000000000" || v.lambdaWad === 1e18 ? "#3d6fa8" : "#3ef0a6" }))} />}
          </div></Reveal>
          <Reveal><div className="panel glass" style={{ height: "100%" }}>
            <h3 style={{ fontSize: 20 }}>What it shows</h3>
            <ul className="limit">
              <li>λ = 100% reproduces the real plain Uniswap v4 pool (difference {plain && replay ? fmt(Math.abs(replay.venues[1].lpLossVsRebalancedUsdc6 - plain.lpLossVsRebalancedUsdc6) / plain.lpLossVsRebalancedUsdc6 * 100, 2) : "–"}%).</li>
              <li>The v4 hook and the 1inch Aqua position lose exactly the same at the same λ: one kernel, two venues.</li>
              <li>At 5 bps, exposing half the pool cut the loss {halfPct != null ? fmt(halfPct, 1) : "–"}%, and the keeper tunes λ to each pool&apos;s fee.</li>
            </ul>
            <div className="code">REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv</div>
          </div></Reveal>
        </div>
      </section>

      <section id="trade" className="lsec"><h2>Trade against both venues</h2>
        <Reveal><div className="panel glass">
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><span className="t2">size $</span><input className="field" type="number" value={usd} min={0.01} step={0.01} max={2000} onChange={e => setUsd(Number(e.target.value) || 1)} /></div>
          <div className="btnrow">
            <button id="buy-v4" disabled={off} className="lbtn primary" onClick={() => trade("v4", "buy")}>Buy ETH on Uniswap v4</button>
            <button id="sell-v4" disabled={off} className="lbtn uni" onClick={() => trade("v4", "sell")}>Sell ETH on Uniswap v4</button>
            <button id="buy-aqua" disabled={off} className="lbtn primary" onClick={() => trade("aqua", "buy")}>Buy ETH on 1inch Aqua</button>
            <button id="sell-aqua" disabled={off} className="lbtn aq" onClick={() => trade("aqua", "sell")}>Sell ETH on 1inch Aqua</button>
            {sh && <><button id="buy-official" disabled={off} className="lbtn aq" onClick={() => trade("official", "buy")}>Buy on 1inch official router</button>
              <button id="sell-official" disabled={off} className="lbtn aq" onClick={() => trade("official", "sell")}>Sell on 1inch official router</button></>}
          </div>
          <div className="result" id="trade-result">{tradeMsg}</div>
        </div></Reveal>
      </section>

      <section id="activity" className="lsec"><h2>On-chain activity</h2>
        <div className="panel glass feed" data-lenis-prevent>
          {act.items.length ? <AnimatePresence initial={false}>{act.items.map((i: any) => <motion.div key={i.key} layout className="ev"
            initial={i.isNew ? { opacity: 0, x: -30, backgroundColor: "rgba(124,232,255,.22)" } : false} animate={{ opacity: 1, x: 0, backgroundColor: "rgba(124,232,255,0)" }} transition={{ duration: 1.2 }}>
            <span className={`srcpill ${srcClass(i.source)}`}>{i.source}</span> {i.text} <span className="muted">· block {i.block} · tx {st?.network === "mainnet" ? <a href={`https://basescan.org/tx/${i.tx}`} target="_blank" rel="noreferrer">{short(i.tx)} ↗</a> : short(i.tx)}</span>
          </motion.div>)}</AnimatePresence> : <div className="empty">no activity yet</div>}
        </div>
      </section>

      <section id="api" className="lsec"><h2>API</h2>
        <div className="panel glass">
          <div className="btnrow" style={{ marginTop: 0 }}>
            <button className="lbtn" onClick={() => call("/api/status")}>GET /api/status</button>
            <button className="lbtn" onClick={() => call(`/api/quote?venue=v4&side=buy&usd=${usd}`)}>GET /api/quote (v4)</button>
            <button className="lbtn" onClick={() => call(`/api/quote?venue=aqua&side=buy&usd=${usd}`)}>GET /api/quote (Aqua)</button>
            <button className="lbtn" onClick={() => call(`/api/swap?venue=aqua&side=buy&usd=${usd}`, "POST")}>POST /api/swap</button>
          </div>
          <div className="code" style={{ marginTop: 14 }}>curl -s -X POST &quot;localhost:8788/api/swap?venue=v4&amp;side=buy&amp;usd=50&quot; | jq</div>
          <pre className="code" id="api-out" data-lenis-prevent>{apiOut || "responses appear here"}</pre>
        </div>
      </section>
    </div>
    <Footer />
    <div id="toasts"><AnimatePresence>{toasts.map(t => <motion.div key={t.id} className="toast glass" layout initial={{ opacity: 0, y: 30, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 60 }} transition={SPRING}>
      {t.text}<div className={`tsrc ${srcClass(t.src)}`}>from {t.src}</div></motion.div>)}</AnimatePresence></div>
  </main>;
}
