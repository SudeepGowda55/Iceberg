"use client";
import { motion, useInView } from "motion/react";
import { useRef, useState } from "react";
import { CountUp, Reveal, SplitText, Tilt } from "@/components/fx";
import { Footer } from "@/components/Shell";
import replay from "@/data/snapshot/replay.json";
import { PRICES } from "@/lib/sim";
import { AQUA_STUDY, CLAIMS } from "@/lib/site";

const EASE = [0.22, 1, 0.36, 1] as const;
const label = (n: string) => n.includes("plain") ? "Plain Uniswap v4 pool" : n.includes("Aqua") ? "Iceberg · 1inch Aqua, λ 50%" : `Iceberg · v4 hook, λ ${n.match(/lambda (\d+)%/)?.[1]}%`;
const color = (n: string) => n.includes("plain") ? "linear-gradient(90deg,#ff8fbf,var(--hot))" : n.includes("Aqua") ? "linear-gradient(90deg,#a4f2f7,var(--aqua))" : n.includes("100%") ? "linear-gradient(90deg,#9ab9dd,#5a7fae)" : "linear-gradient(90deg,#a8ffd9,var(--morpho))";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button className="copy" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}>{done ? "copied ✓" : "copy"}</button>;
}

function PriceLine() {
  const ref = useRef<SVGSVGElement>(null), inView = useInView(ref, { once: true, margin: "-15% 0px" });
  const W = 1200, H = 260, pts = PRICES.filter((_, i) => i % 4 === 0), mn = Math.min(...pts), mx = Math.max(...pts);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(i / (pts.length - 1) * W).toFixed(1)},${(H - 20 - (p - mn) / (mx - mn) * (H - 40)).toFixed(1)}`).join("");
  return <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: 260 }} role="img" aria-label={`ETH/USD on 21 Sep 2026, from $${replay.startPrice} to $${replay.endPrice}`}>
    <defs><linearGradient id="pl" x1="0" x2="1"><stop offset="0" stopColor="#6aa8ff" /><stop offset="1" stopColor="#7ce8ff" /></linearGradient>
      <linearGradient id="pf" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7ce8ff" stopOpacity=".22" /><stop offset="1" stopColor="#7ce8ff" stopOpacity="0" /></linearGradient></defs>
    <motion.path d={`${d}L${W},${H}L0,${H}Z`} fill="url(#pf)" initial={{ opacity: 0 }} animate={inView ? { opacity: 1 } : {}} transition={{ delay: 1.6, duration: 1 }} />
    <motion.path d={d} fill="none" stroke="url(#pl)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" initial={{ pathLength: 0 }} animate={inView ? { pathLength: 1 } : {}} transition={{ duration: 2.4, ease: "easeInOut" }} />
  </svg>;
}

function Donut() {
  const ref = useRef<HTMLDivElement>(null), inView = useInView(ref, { once: true, margin: "-15% 0px" });
  const r = 80, c = 2 * Math.PI * r, f = AQUA_STUDY.neverFilledPct / 100;
  return <div ref={ref} className="donut">
    <svg viewBox="0 0 200 200" style={{ width: "100%", rotate: "-90deg" }} aria-hidden>
      <circle cx="100" cy="100" r={r} fill="none" stroke="rgba(124,232,255,.14)" strokeWidth="18" />
      <motion.circle cx="100" cy="100" r={r} fill="none" stroke="var(--hot)" strokeWidth="18" strokeLinecap="round" strokeDasharray={c}
        initial={{ strokeDashoffset: c }} animate={inView ? { strokeDashoffset: c * (1 - f) } : {}} transition={{ duration: 2, ease: EASE }} />
    </svg>
    <div className="c"><div><b className="hot"><CountUp to={AQUA_STUDY.neverFilledPct} decimals={1} suffix="%" /></b><span className="t2">never filled</span></div></div>
  </div>;
}

export default function Evidence() {
  const venues = replay.venues, max = Math.max(...venues.map(v => v.lpLossVsRebalancedUsdc6)), plain = venues[0].lpLossVsRebalancedUsdc6;
  return <main className="above">
    <section className="phead wrap">
      <Reveal><div className="kicker">Evidence · every number has a command</div></Reveal>
      <SplitText text="The real 24 hours ending 21 Sep." className="display h-l" />
      <Reveal delay={0.4}><div className="bigstat grad-m"><CountUp to={19.3} decimals={1} prefix="−" suffix="%" duration={2.6} /></div></Reveal>
      <Reveal delay={0.5}><p className="lede">Less lost to arbitrage than a real plain Uniswap v4 pool at the same 5 bps fee, at λ 39%. Replayed minute by minute on a Base mainnet fork against the real PoolManager and official Aqua.</p></Reveal>
    </section>

    <section className="wrap">
      <Reveal><div className="glass panel" style={{ padding: "26px 26px 10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <span className="t2">ETH/USD · Coinbase 1-minute closes</span>
          <span className="mono"><span className="t2">${replay.startPrice.toLocaleString()}</span> → <span className="tip">${replay.endPrice.toLocaleString()}</span> <span className="morpho">+6.24%</span></span>
        </div>
        <PriceLine />
      </div></Reveal>
    </section>

    <section className="section wrap">
      <Reveal><div className="kicker">LP loss vs a perfectly rebalanced portfolio</div></Reveal>
      <SplitText as="h2" text="Shorter is better." className="display h-m" />
      <div className="race">
        {venues.map((v, i) => <Reveal key={v.name} delay={i * 0.08}><div className="race-row">
          <div className="name">{label(v.name)} <span className="muted mono" style={{ fontSize: 12 }}>· {v.trades} trades</span></div>
          <div className="track"><motion.div className="fill" style={{ background: color(v.name), width: `${v.lpLossVsRebalancedUsdc6 / max * 100}%` }}
            initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: 1.4, ease: EASE, delay: 0.2 + i * 0.12 }}>
            {i > 0 && v.lpLossVsRebalancedUsdc6 < plain * 0.98 ? `−${((1 - v.lpLossVsRebalancedUsdc6 / plain) * 100).toFixed(1)}%` : ""}</motion.div></div>
          <div className="val tnum">${(v.lpLossVsRebalancedUsdc6 / 1e6).toFixed(3)}</div>
        </div></Reveal>)}
      </div>
      <Reveal><p className="muted" style={{ fontSize: 14, marginTop: 26, maxWidth: 760 }}>λ 100% reproduces the plain pool to 0.09%. The v4 hook and the Aqua position at λ 50% lose exactly the same: one kernel, two venues.</p></Reveal>
    </section>

    <section className="section wrap" style={{ paddingTop: 0 }}>
      <Reveal><div className="kicker">Reproduce it</div></Reveal>
      <SplitText as="h2" text="Don't trust us. Run it." className="display h-l" />
      <div className="claims">
        {CLAIMS.map((c, i) => <Reveal key={c.title} delay={(i % 3) * 0.08}><Tilt className="glass claim" max={6} style={{ borderRadius: "var(--r)", height: "100%" }}>
          <div className="stat-s grad">{c.stat}</div><h3>{c.title}</h3><p>{c.body}</p>
          <div className="cmd"><code>{c.cmd}</code><Copy text={c.cmd} /></div>
        </Tilt></Reveal>)}
      </div>
    </section>

    <section className="section wrap" style={{ paddingTop: 0 }}>
      <Reveal><div className="kicker">Why vault-held inventory</div></Reveal>
      <SplitText as="h2" text="Most Aqua liquidity on Base just sits there." className="display h-l" />
      <div className="donut-wrap">
        <Donut />
        <div>
          {[[AQUA_STUDY.strategies, "strategies shipped to Aqua on Base since launch"], [AQUA_STUDY.makers, "makers behind them"], [AQUA_STUDY.makersNeverFilled, "makers never got a single fill"], [AQUA_STUDY.liveUnbacked, `of ${AQUA_STUDY.liveNeverFilled} live never-filled strategies have no money behind them`]].map(([n, t], i) =>
            <Reveal key={i} delay={i * 0.08}><div className="kv" style={{ padding: "18px 0", alignItems: "baseline" }}><span className="display" style={{ fontSize: 48 }}><CountUp to={n as number} /></span><span className="t2" style={{ maxWidth: 360, textAlign: "right" }}>{t}</span></div></Reveal>)}
          <Reveal><p className="muted" style={{ fontSize: 14, marginTop: 18 }}>Iceberg's idle side earns in Morpho instead of waiting. <span className="mono">node research/aqua_base_study.mjs</span></p></Reveal>
        </div>
      </div>
    </section>
    <Footer />
  </main>;
}
