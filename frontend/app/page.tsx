"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart } from "@/components/Charts";
import { fmt, short, usd0 } from "@/lib/ui";

type Toast = { id: number; text: string; src: string };
const NETQ = () => (typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("net") || "local");
const withNet = (p: string) => `${p}${p.includes("?") ? "&" : "?"}net=${NETQ()}`;
const srcClass = (s: string) => (s === "terminal / API" ? "src-cli" : s === "UI" ? "src-ui" : s === "keeper" || s === "maker / keeper" ? "src-agent" : "");

export default function Page() {
  const [st, setSt] = useState<any>(null);
  const [act, setAct] = useState<any>({ items: [], counts: {} });
  const [replay, setReplay] = useState<any>(null);
  const [err, setErr] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tradeMsg, setTradeMsg] = useState<any>("");
  const [apiOut, setApiOut] = useState("");
  const [usd, setUsd] = useState(25);
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

  const u = st?.uniswapV4, a = st?.oneInchAqua, sh = st?.sharedLiquidity, rb = st?.rebalance, k = st?.keeper, pol = k?.policy;
  const [rbMsg, setRbMsg] = useState<any>("");
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

  const Stack = ({ active, passive, parked }: { active: number; passive: number; parked: number }) => {
    const tot = active + passive + parked || 1;
    return <div className="stack" role="img" aria-label={`active ${fmt(active / tot * 100, 0)}%, passive ${fmt(passive / tot * 100, 0)}%, in Morpho ${fmt(parked / tot * 100, 0)}%`}>
      <div className="seg-active" style={{ width: `${active / tot * 100}%` }} /><div className="seg-passive" style={{ width: `${passive / tot * 100}%` }} /><div className="seg-parked" style={{ width: `${parked / tot * 100}%` }} />
    </div>;
  };

  return <>
    <header><div className="wrap hdr">
      <div className="brand">Iceberg<small>{err ? <span className="bad">{err}</span> : st ? (st.mirror ? "local fork of Base mainnet · real Aqua, v4 PoolManager, Morpho" : st.network === "mainnet" ? "Base mainnet" : `${st.network}: Base fork rehearsal with the real wallet`) : "loading…"}</small></div>
      <nav>{["overview", "venues", "keeper", "replay", "trade", "activity", "api", "limits"].map(s => <a key={s} href={`#${s}`}>{s[0].toUpperCase() + s.slice(1)}</a>)}</nav>
      <div className="hdr-right">{st && <><span className="pill">block {st.block}</span><span className="pill">ETH ${fmt(st.ethUsd)}</span><span className="pill">keeper {st.keeperUpdated ? `${Math.max(0, Math.floor(Date.now() / 1000) - st.keeperUpdated)}s ago` : "–"}</span></>}</div>
    </div></header>

    <main className="wrap">
      <section id="overview" className="hero">
        <h1 style={{ fontSize: 34, lineHeight: 1.15, margin: "0 0 10px", maxWidth: 1100 }}>Only a fraction <span className="venue-aqua">λ</span> of the pool can be arbitraged in any block. The rest earns in <span className="good">Morpho</span>.</h1>
        <p className="lede">Iceberg implements the Partially Active AMM (Ko 2026) as a <b className="venue-aqua">1inch Aqua</b> position and a <b className="venue-uni">Uniswap v4</b> hook with one shared kernel. A fee-aware keeper picks λ from recent real prices, because at high fees partial activity stops helping.</p>
        <div className="grid g-kpi">
          <div className="panel kpi"><div className="k">Loss to arbitrage saved, real 21 Sep replay</div><div className="v good">{savedPct != null ? `${fmt(savedPct, 1)}%` : "–"}</div><div className="s">vs a real plain v4 pool, 1,440 min, 5 bps{halfPct != null ? ` · λ 50%: ${fmt(halfPct, 1)}%` : ""}</div></div>
          <div className="panel kpi"><div className="k">λ now (keeper)</div><div className="v">{u ? `${fmt(u.lambdaPct, 0)}%` : "–"}</div><div className="s">{pol ? `${fmt(pol.savedPct, 1)}% less loss on the last ${pol.minutes} min` : "waiting for keeper"}</div></div>
          <div className="panel kpi"><div className="k">Liquidity, both venues</div><div className="v">{st ? usd0(u.totalValueUsd + a.totalValueUsd) : "–"}</div><div className="s">tradable this block: {st ? usd0(u.activeValueUsd + a.activeValueUsd) : "–"}</div></div>
          <div className="panel kpi"><div className="k">Earning in Morpho</div><div className="v good">{st ? usd0(u.parkedInMorphoUsd + a.inMorphoUsd) : "–"}</div><div className="s">Steakhouse USDC · Moonwell ETH vaults</div></div>
          <div className="panel kpi"><div className="k">Per-block splits on-chain</div><div className="v">{act.counts?.splits ?? "–"}</div><div className="s">{act.counts?.v4Swaps ?? 0} v4 swaps · {act.counts?.aquaSwaps ?? 0} Aqua fills · {act.counts?.sharedSwaps ?? 0} shared · {act.counts?.rebalances ?? 0} rebalances</div></div>
          <div className="panel kpi"><div className="k">Live Base Chainlink</div><div className="v">{st?.liveBaseChainlink?.ethUsd ? `$${fmt(st.liveBaseChainlink.ethUsd)}` : "–"}</div><div className="s">{st?.mirror ? "mirrored into the fork each keeper tick" : "read directly"}</div></div>
        </div>
      </section>

      <section id="venues"><h2>Two venues, one kernel</h2>
        <div className="grid g-2">
          {[["Uniswap v4 hook", u, "venue-uni"], ["1inch Aqua position", a, "venue-aqua"]].map(([name, v, cls]: any) =>
            <div key={name} className="panel">
              <h3 className={cls}>{name}</h3>
              <div className="t2" style={{ fontSize: 13 }}>{v ? (cls === "venue-uni" ? `hook ${short(v.hook)} · pool ${short(v.poolId)} · ${v.feeBps} bps` : `order ${short(v.orderHash)} · ${v.feeBps} bps · inventory in Morpho vaults`) : "–"}</div>
              {v && <>
                <Stack active={v.activeValueUsd} passive={Math.max(0, v.totalValueUsd - v.activeValueUsd - (v.parkedInMorphoUsd ?? 0))} parked={v.parkedInMorphoUsd ?? 0} />
                <div className="legend2"><span><i className="seg-active" />active this block {usd0(v.activeValueUsd)}</span><span><i className="seg-passive" />passive (frozen)</span>{cls === "venue-uni" && <span><i className="seg-parked" />parked in Morpho {usd0(v.parkedInMorphoUsd)}</span>}</div>
                <div style={{ marginTop: 10 }}>
                  <div className="kv"><span className="k">λ</span><span className="v">{fmt(v.lambdaPct, 0)}%</span></div>
                  <div className="kv"><span className="k">reserves</span><span className="v">{fmt((v.reserves ?? v.balances).weth, 4)} WETH + {fmt((v.reserves ?? v.balances).usdc)} USDC</span></div>
                  <div className="kv"><span className="k">active (arbitrage can reach)</span><span className="v">{fmt(v.active.weth, 4)} WETH + {fmt(v.active.usdc)} USDC</span></div>
                  {cls === "venue-uni" ? <div className="kv"><span className="k">in pool / in Morpho</span><span className="v">{fmt(v.inPool.weth, 4)} / {fmt(v.parked.weth, 4)} WETH</span></div>
                    : <div className="kv"><span className="k">maker's Morpho vault balances</span><span className="v">{fmt(v.inMorpho.weth, 4)} WETH + {fmt(v.inMorpho.usdc)} USDC</span></div>}
                  <div className="kv"><span className="k">last split block</span><span className="v">{v.lastSplitBlock || "–"}</span></div>
                </div>
              </>}
            </div>)}
          {sh && <div className="panel">
            <h3 className="venue-aqua">1inch official router · shared liquidity</h3>
            <div className="t2" style={{ fontSize: 13 }}>order {short(sh.orderHash)} · plain 5 bps curve on 1inch&apos;s unmodified router</div>
            <p className="why">The <b>same Morpho vault shares</b> back this strategy and the Iceberg position: Aqua lets one balance serve several strategies, and each fill withdraws exactly what it needs.</p>
            <div className="kv"><span className="k">committed from the shared balance</span><span className="v">{fmt(sh.balances.weth, 4)} WETH + {fmt(sh.balances.usdc)} USDC ({usd0(sh.valueUsd)})</span></div>
            <div className="kv"><span className="k">maker&apos;s Morpho balance behind both</span><span className="v">{a ? `${fmt(a.inMorpho.weth, 4)} WETH + ${fmt(a.inMorpho.usdc)} USDC` : "–"}</span></div>
          </div>}
          {rb && <div className="panel">
            <h3>Weight tracking</h3>
            <p className="why">A partially active pool lags the market, so its mix drifts. When the Aqua position&apos;s ETH weight at the live price leaves 50% ± {fmt(rb.bandPct, 1)}%, the keeper retires it, rebalances the Morpho holdings through Uniswap, and re-ships it balanced. That resets the stale price without paying arbitrageurs.</p>
            <div className="kv"><span className="k">ETH weight now</span><span className="v">{rb.weightEthPct != null ? `${fmt(rb.weightEthPct, 2)}%` : "–"}</span></div>
            <div className="kv"><span className="k">rebalances so far</span><span className="v">{rb.count} · strategy salt {rb.salt}</span></div>
            <div className="btnrow"><button id="rebalance" onClick={rebalance}>Rebalance now</button></div>
            <div className="result" id="rebalance-result">{rbMsg}</div>
          </div>}
        </div>
      </section>

      <section id="keeper"><h2>Fee-aware keeper</h2>
        <div className="grid g-2">
          <div className="panel">
            <h3>Why λ = {pol ? `${fmt(k.lambda * 100, 0)}%` : "…"}</h3>
            <p className="why">{pol ? <>On the last <b>{pol.minutes}</b> minutes of real ETH/USD (annualised vol {fmt(pol.volAnnualPct, 0)}%) at this pool&apos;s <b>{pol.feeBps} bps</b> fee, exposing {fmt(k.lambda * 100, 0)}% of the reserves loses <b className="good">{fmt(pol.bestLossBps, 3)} bps</b> to arbitrage versus <b>{fmt(pol.plainLossBps, 3)} bps</b> fully active ({fmt(pol.savedPct, 1)}% saved). At high fees the same search returns λ = 100%. λ never goes below the maker&apos;s floor of {fmt(pol.floor * 100, 0)}%, because fewer active reserves also means worse prices for ordinary traders.</> : "the keeper publishes its first decision within a minute"}</p>
            {pol && <><div className="t2" style={{ fontSize: 12, marginTop: 8 }}>loss to arbitrage at each λ, as % of the fully active loss</div>
              <BarChart height={200} vFmt={v => fmt(v, 1) + "%"} bars={pol.table.filter((t: any, i: number) => i % 2 === 0 || t.lambda === k.lambda).map((t: any) => ({ label: `λ ${fmt(t.lambda * 100, 0)}%`, v: t.lossBps / pol.table[0].lossBps * 100, color: t.lambda === k.lambda ? "#199e70" : "#56585e" }))} /></>}
          </div>
          <div className="panel">
            <h3>Last keeper tick</h3>
            {k ? <div className="feed" style={{ maxHeight: 300 }}>
              <div className="ev">live Base ETH/USD ${fmt(k.live?.ethUsd)} ({k.live?.ageSeconds}s old)</div>
              {k.actions.map((x: any, i: number) => <div key={i} className="ev">{x.what}{x.tx && <span className="muted"> · tx {short(x.tx)}</span>}</div>)}
              {k.arbs.map((x: any, i: number) => <div key={"a" + i} className="ev"><span className="srcpill">simulated arbitrageur</span> {x.error ? x.error : `${x.side} on ${x.venue}: pool $${fmt(x.poolPrice)} → live $${fmt(x.livePrice)}`}</div>)}
            </div> : <div className="empty">no keeper tick yet</div>}
          </div>
        </div>
      </section>

      <section id="replay"><h2>Real replay: 24 hours ending 21 Sep 2026 20:31 UTC</h2>
        <div className="grid g-2">
          <div className="panel">
            <h3>LP loss versus a perfectly rebalanced portfolio</h3>
            <p className="why">ETH ${replay ? fmt(replay.startPrice) : "…"} → ${replay ? fmt(replay.endPrice) : "…"} (+6.24%). Every minute a rational arbitrageur trades each venue to the real Coinbase close, on a Base mainnet fork with the real v4 PoolManager and official Aqua. Same 5 bps fee and starting reserves for all.</p>
            {replay && <BarChart height={220} vFmt={v => "$" + fmt(v, 3)} bars={replay.venues.map((v: any, i: number) => ({ label: v.name.includes("plain") ? "plain v4" : (v.name.includes("Aqua") ? "Aqua " : "hook ") + "λ" + Math.round(Number(v.lambdaWad) / 1e16) + "%", v: v.lpLossVsRebalancedUsdc6 / 1e6, color: i === 0 ? "#8b8a82" : v.name.includes("Aqua") ? "#4fd1db" : v.lambdaWad === "1000000000000000000" || v.lambdaWad === 1e18 ? "#56585e" : "#199e70" }))} />}
          </div>
          <div className="panel">
            <h3>What it shows, honestly</h3>
            <ul className="limit">
              <li>λ = 100% reproduces the real plain Uniswap v4 pool (difference {plain && replay ? fmt(Math.abs(replay.venues[1].lpLossVsRebalancedUsdc6 - plain.lpLossVsRebalancedUsdc6) / plain.lpLossVsRebalancedUsdc6 * 100, 2) : "–"}%).</li>
              <li>The v4 hook and the 1inch Aqua position lose exactly the same at the same λ: one kernel, two venues.</li>
              <li>At 5 bps, exposing half the pool cut the loss {halfPct != null ? fmt(halfPct, 1) : "–"}%. The simulation shows the effect fades at 30 bps, which is why λ is fee-aware.</li>
              <li>Arbitrage-only flow: fewer active reserves also means worse prices for ordinary traders, not modelled here.</li>
            </ul>
            <div className="code">REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv</div>
          </div>
        </div>
      </section>

      <section id="trade"><h2>Trade against both venues</h2>
        <div className="panel">
          <div className="row"><span className="t2">size $</span><input type="number" value={usd} min={1} max={2000} onChange={e => setUsd(Number(e.target.value) || 1)} style={{ width: 90 }} /></div>
          <div className="btnrow">
            <button id="buy-v4" className="primary" onClick={() => trade("v4", "buy")}>Buy ETH on Uniswap v4</button>
            <button id="sell-v4" onClick={() => trade("v4", "sell")}>Sell ETH on Uniswap v4</button>
            <button id="buy-aqua" className="primary" onClick={() => trade("aqua", "buy")}>Buy ETH on 1inch Aqua</button>
            <button id="sell-aqua" onClick={() => trade("aqua", "sell")}>Sell ETH on 1inch Aqua</button>
            {sh && <><button id="buy-official" onClick={() => trade("official", "buy")}>Buy on 1inch official router</button>
            <button id="sell-official" onClick={() => trade("official", "sell")}>Sell on 1inch official router</button></>}
          </div>
          <div className="result" id="trade-result">{tradeMsg}</div>
        </div>
      </section>

      <section id="activity"><h2>On-chain activity</h2>
        <div className="panel feed">
          {act.items.length ? act.items.map((i: any) => <div key={i.key} className={`ev${i.isNew ? " fresh" : ""}`}><span className={`srcpill ${srcClass(i.source)}`}>{i.source}</span> {i.text} <span className="muted">· block {i.block} · tx {short(i.tx)}</span></div>) : <div className="empty">no activity yet</div>}
        </div>
      </section>

      <section id="api"><h2>API</h2>
        <div className="panel">
          <div className="btnrow">
            <button onClick={() => call("/api/status")}>GET /api/status</button>
            <button onClick={() => call(`/api/quote?venue=v4&side=buy&usd=${usd}`)}>GET /api/quote (v4)</button>
            <button onClick={() => call(`/api/quote?venue=aqua&side=buy&usd=${usd}`)}>GET /api/quote (Aqua)</button>
            <button onClick={() => call(`/api/swap?venue=aqua&side=buy&usd=${usd}`, "POST")}>POST /api/swap</button>
          </div>
          <div className="code" style={{ marginTop: 12 }}>curl -s -X POST &quot;localhost:8788/api/swap?venue=v4&amp;side=buy&amp;usd=50&quot; | jq</div>
          <pre className="code" style={{ whiteSpace: "pre", maxHeight: 320, overflow: "auto", marginTop: 10 }} id="api-out">{apiOut || "responses appear here"}</pre>
        </div>
      </section>

      <section id="limits"><h2>Limitations</h2>
        <div className="panel"><ul className="limit">
          <li>The benefit depends on the fee: about 30% less loss at 1 bps, 17% at 5 bps, nothing (or worse) at 30 bps on real data.</li>
          <li>The paper&apos;s state-dependent λ(g) equals a fixed λ in practice (zero drift); it ships as an option, the keeper is the default.</li>
          <li>Only arbitrage flow is modelled; less active liquidity also means worse prices for ordinary traders.</li>
          <li>The v4 reference price can be pushed inside a transaction; a Chainlink deviation guard bounds it, it does not remove it.</li>
          <li>Weight tracking re-ships the Aqua position after trading on Uniswap v3; each rebalance pays that pool&apos;s fee and slippage.</li>
          <li>{st?.mirror ? "Local fork: the MirrorFeed copies live Base Chainlink each tick; the arbitrageur is simulated and labelled." : "Mainnet: real Chainlink, real flow."}</li>
        </ul></div>
      </section>
      <footer className="muted" style={{ padding: "30px 0", fontSize: 13 }}>Iceberg · PA-AMM (Ko 2026, arXiv 2602.09887) on official 1inch Aqua & SwapVM and Uniswap v4 (OpenZeppelin BaseCustomCurve) · related work: Tide (Tokyo 2026), Barker (ETHOnline 2026)</footer>
    </main>
    <div id="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}<div className={`tsrc ${srcClass(t.src)}`}>from {t.src}</div></div>)}</div>
  </>;
}
