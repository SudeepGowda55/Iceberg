"use client";
import gsap from "gsap";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Reveal, SplitText } from "@/components/fx";
import { Footer } from "@/components/Shell";
import { resetScene, scene } from "@/lib/sceneStore";
import { PRICES, arbProfit, lambdaStar, simulate, sweep } from "@/lib/sim";

const IcebergScene = dynamic(() => import("@/components/IcebergScene"), { ssr: false });
const FEES = [{ bps: 1, f: 0.0001 }, { bps: 5, f: 0.0005 }, { bps: 30, f: 0.003 }];
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

function Seg<T extends string | number>({ value, options, onChange, id }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; id: string }) {
  return <div className="seg" role="radiogroup">
    {options.map(o => <button key={String(o.v)} role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
      {o.v === value && <motion.span layoutId={`seg-${id}`} className="pill" transition={{ type: "spring", stiffness: 400, damping: 34 }} />}<span>{o.label}</span></button>)}
  </div>;
}

/** Real 21 Sep price on top, cumulative LP loss (plain vs Iceberg) below; `progress` reveals it left to right. */
function ReplayChart({ plain, berg, progress }: { plain: number[]; berg: number[]; progress: number }) {
  const W = 640, H = 300, L = 46, R = 10, T = 10, mid = 120, B = 24;
  const px = PRICES.filter((_, i) => i % 10 === 0 || i === PRICES.length - 1);
  const pmin = Math.min(...px), pmax = Math.max(...px), lmax = Math.max(...plain, ...berg, 1e-9);
  const X = (i: number, n: number) => L + (i / (n - 1)) * (W - L - R);
  const line = (a: number[], y: (v: number) => number) => a.map((v, i) => `${i ? "L" : "M"}${X(i, a.length).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const yP = (v: number) => T + (1 - (v - pmin) / (pmax - pmin)) * (mid - T - 14);
  const yL = (v: number) => mid + 16 + (1 - v / lmax) * (H - B - mid - 16);
  const clipW = L + progress * (W - L - R);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="ETH price on 21 Sep and cumulative LP loss, plain AMM vs Iceberg">
    <defs><clipPath id="rv"><rect x="0" y="0" width={clipW} height={H} /></clipPath>
      <linearGradient id="lossfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff5fa2" stopOpacity=".28" /><stop offset="1" stopColor="#ff5fa2" stopOpacity="0" /></linearGradient></defs>
    <text x={L} y={T + 2} dy="-2">ETH/USD ${pmin.toFixed(0)}–${pmax.toFixed(0)}</text>
    <text x={L} y={mid + 12}>cumulative LP loss, $ per $100k</text>
    {[0, 0.5, 1].map(f => <g key={f}><line x1={L} x2={W - R} y1={yL(lmax * f)} y2={yL(lmax * f)} stroke="rgba(160,210,255,.1)" /><text x={L - 6} y={yL(lmax * f) + 4} textAnchor="end">{(lmax * f).toFixed(f ? 1 : 0)}</text></g>)}
    <g clipPath="url(#rv)">
      <path d={line(px, yP)} fill="none" stroke="#dff4ff" strokeWidth="1.4" opacity=".8" />
      <path d={`${line(plain, yL)}L${X(plain.length - 1, plain.length)},${yL(0)}L${L},${yL(0)}Z`} fill="url(#lossfill)" />
      <path d={line(plain, yL)} fill="none" stroke="var(--hot)" strokeWidth="2.2" />
      <path d={line(berg, yL)} fill="none" stroke="var(--morpho)" strokeWidth="2.6" />
    </g>
    {progress > 0 && progress < 1 && <line x1={clipW} x2={clipW} y1={T} y2={H - B} stroke="#fff" strokeOpacity=".5" strokeDasharray="3 4" />}
    {["00:00", "06:00", "12:00", "18:00", "24h"].map((t, i) => <text key={t} x={L + (i / 4) * (W - L - R)} y={H - 6} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{t}</text>)}
  </svg>;
}

/** x·y = k for the whole pool vs the λ²k curve the arbitrageur actually trades against this block. */
function CurveViz({ lambda, jump }: { lambda: number; jump: number }) {
  const W = 520, H = 360, L = 40, B = 30, k = 1, x0 = 1, sx = (x: number) => L + (x / 2.6) * (W - L - 10), sy = (y: number) => H - B - (y / 2.6) * (H - B - 10);
  const curve = (kk: number) => { const pts: string[] = []; for (let x = 0.12; x <= 2.6; x += 0.02) { const y = kk / x; if (y <= 2.6) pts.push(`${pts.length ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`); } return pts.join(""); };
  const ka = lambda * lambda * k, xa = lambda * x0;
  const p1 = 1 + jump, xFull = Math.sqrt(k / p1), xAct = Math.sqrt(ka / p1);
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Constant-product curves for the full pool and the active reserves">
    <line x1={L} x2={W - 10} y1={H - B} y2={H - B} stroke="rgba(160,210,255,.2)" /><line x1={L} x2={L} y1={10} y2={H - B} stroke="rgba(160,210,255,.2)" />
    <text x={W - 10} y={H - 10} textAnchor="end">ETH reserve</text><text x={L + 6} y={20}>USDC reserve</text>
    <path d={curve(k)} fill="none" stroke="var(--frozen)" strokeWidth="2" strokeDasharray="5 5" />
    <motion.path initial={false} d={curve(ka)} fill="none" stroke="var(--tip)" strokeWidth="3" animate={{ d: curve(ka) }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
    <motion.circle initial={false} r="7" fill="none" stroke="var(--frozen)" strokeWidth="2" animate={{ cx: sx(xFull), cy: sy(k / xFull) }} />
    <circle r="6" fill="var(--frozen)" opacity=".5" cx={sx(x0)} cy={sy(k / x0)} />
    <motion.circle initial={false} r="6" fill="var(--tip)" animate={{ cx: sx(xa), cy: sy(ka / xa) }} />
    <motion.circle initial={false} r="8" fill="var(--hot)" animate={{ cx: sx(xAct), cy: sy(ka / xAct) }} transition={{ type: "spring", stiffness: 140, damping: 16 }} />
    <motion.line initial={false} stroke="var(--hot)" strokeWidth="1.5" strokeDasharray="3 3" animate={{ x1: sx(xa), y1: sy(ka / xa), x2: sx(xAct), y2: sy(ka / xAct) }} />
    <text x={sx(2.2)} y={sy(k / 2.2) - 10} fill="var(--frozen)" style={{ fill: "#8db8ea" }}>whole pool · k</text>
    <motion.text initial={false} animate={{ x: sx(Math.min(2.4, 2.2 * lambda + 0.2)), y: sy(ka / Math.min(2.4, 2.2 * lambda + 0.2)) - 10 }} style={{ fill: "var(--tip)" }}>active · λ²k</motion.text>
  </svg>;
}

const STEPS = [
  { t: "A block opens.", p: "Base mints a block every 2 seconds. Until someone trades, the pool holds R: its total reserves, on both venues.", viz: "open" },
  { t: "The first trade splits R.", p: "λ·R becomes the active side. (1 − λ)·R is frozen for the rest of the block: it is not in the curve, so nothing in this block can touch it.", viz: "split" },
  { t: "Arbitrage sees only the tip.", p: "Every trade in the block, the arbitrageur's included, is priced by x·y = k on the active reserves, with a 5 bps fee. Quotes never write storage, so quote == swap.", viz: "arb" },
  { t: "The frozen part earns.", p: "Idle reserves sit in Morpho vaults and are pulled out mid-swap only if a trade needs them. Next block, the reserves re-split at the keeper's current λ.", viz: "park" },
];

function StepViz({ kind, lambda }: { kind: string; lambda: number }) {
  const a = Math.round(lambda * 100), f = 100 - a;
  const spring = { type: "spring" as const, stiffness: 90, damping: 18 };
  if (kind === "open") return <div className="stackbar"><motion.div className="s-active" style={{ flex: 1, background: "linear-gradient(90deg,#b8f3ff,#6aa8ff)" }} initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} transition={spring}>R · 100%</motion.div></div>;
  if (kind === "split") return <div className="stackbar">
    <motion.div className="s-active" initial={{ flex: 1 }} whileInView={{ flex: a }} transition={{ ...spring, delay: 0.3 }}>λ·R {a}%</motion.div>
    <motion.div className="s-frozen" initial={{ flex: 0 }} whileInView={{ flex: f }} transition={{ ...spring, delay: 0.3 }}>frozen {f}%</motion.div></div>;
  if (kind === "arb") return <div>
    <div className="stackbar" style={{ position: "relative" }}>
      <div className="s-active" style={{ flex: a, position: "relative" }}>reachable</div><div className="s-frozen" style={{ flex: f }}>out of reach</div>
      <motion.div style={{ position: "absolute", top: -6, bottom: -6, width: 4, borderRadius: 4, background: "var(--hot)", boxShadow: "0 0 20px var(--hot)" }}
        animate={{ left: ["2%", `${a - 3}%`, "2%"] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} />
    </div>
    <p className="muted mono" style={{ fontSize: 12, marginTop: 12 }}>the arbitrageur's reach stops at λ</p></div>;
  return <div className="stackbar">
    <div className="s-active" style={{ flex: a }}>active</div>
    <motion.div className="s-morpho" style={{ flex: f }} animate={{ opacity: [0.7, 1, 0.7] }} transition={{ duration: 2, repeat: Infinity }}>in Morpho ↑ yield</motion.div></div>;
}

export default function Mechanism() {
  const [lambda, setLambda] = useState(0.5);
  const [fee, setFee] = useState(0.0005);
  const [progress, setProgress] = useState(1);
  const [jump, setJump] = useState(0.4);
  const [gamma, setGamma] = useState(2);
  const hs = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);

  const plain = useMemo(() => simulate(1, fee), [fee]);
  const berg = useMemo(() => simulate(lambda, fee), [lambda, fee]);
  const sw = useMemo(() => sweep(fee), [fee]);
  const saved = 1 - berg.lossBps / plain.lossBps;
  const maxSweep = Math.max(...sw.rows.map(r => r.lossBps));

  useEffect(() => { resetScene({ lambda: 0.5, arb: 0.45, morpho: 0.8 }); }, []);
  useEffect(() => { scene.lambda = lambda; scene.morpho = 0.25 + (1 - lambda) * 1.2; }, [lambda]);

  const replay = () => {
    const start = performance.now(), D = 5200;
    scene.arb = 1;
    const step = (t: number) => { const p = Math.min(1, (t - start) / D); setProgress(p); if (p < 1) requestAnimationFrame(step); else scene.arb = 0.45; };
    requestAnimationFrame(step);
  };

  // pinned horizontal walk through one block
  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      const dist = () => track.current!.scrollWidth - innerWidth;
      gsap.to(track.current, { x: () => -dist(), ease: "none", scrollTrigger: { trigger: hs.current, start: "top top", end: () => `+=${dist()}`, pin: true, scrub: 1, invalidateOnRefresh: true } });
    });
    return () => ctx.revert();
  }, []);

  const jx = 1, jy = 1, p1 = 1 + jump;
  const profitFull = arbProfit(jx, jy, p1), profitAct = arbProfit(lambda * jx, lambda * jy, p1);

  return <main className="above">
    <section className="phead wrap">
      <Reveal><div className="kicker">The mechanism · Algorithm 1, Ko 2026</div></Reveal>
      <SplitText text="Drag the waterline." className="display h-l" />
      <Reveal delay={0.3}><p className="lede">λ is the share of the reserves arbitrage can reach in a block. Move it and the iceberg sinks or rises, and the real 21 Sep replay re-runs in your browser with the keeper's own model.</p></Reveal>
    </section>

    <section className="wrap sim">
      <div className="sim-stage glass">
        <IcebergScene interactive />
        <div className="stage-badge"><span className="chip"><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--tip)" }} />above water · active</span><span className="chip"><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--frozen)" }} />below · frozen, earning</span></div>
        <div className="stage-l"><div className="mono muted" style={{ fontSize: 12, letterSpacing: ".12em" }}>λ</div><div className="v tnum">{pct(lambda)}</div></div>
      </div>

      <div>
        <div className="panel glass">
          <h3>λ: how much is reachable</h3>
          <p className="sub">The keeper's floor is 40%, so ordinary traders always find deep liquidity. Try 100% to get a plain AMM.</p>
          <input aria-label="lambda" className="range" type="range" min={0.3} max={1} step={0.01} value={lambda} onChange={e => setLambda(Number(e.target.value))} style={{ ["--p" as any]: `${((lambda - 0.3) / 0.7) * 100}%` }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 12, flexWrap: "wrap" }}>
            <span className="t2" style={{ fontSize: 14 }}>pool fee</span>
            <Seg<number> id="fee" value={fee} onChange={setFee} options={FEES.map(x => ({ v: x.f, label: `${x.bps} bps` }))} />
          </div>
          <div className="readouts">
            <div><div className="k">reachable this block</div><div className="v tip tnum">{pct(lambda)}</div></div>
            <div><div className="k">frozen + earning</div><div className="v frozen tnum">{pct(1 - lambda)}</div></div>
            <div><div className="k">LP loss vs plain</div><div className={`v tnum ${saved > 0.0005 ? "morpho" : saved < -0.0005 ? "hot" : ""}`}>{saved >= 0 ? "−" : "+"}{pct(Math.abs(saved), 1)}</div></div>
          </div>
        </div>

        <div className="panel glass">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
            <div><h3>Replay 21 Sep 2026</h3><p className="sub" style={{ marginBottom: 6 }}>1,440 real Coinbase 1-minute closes. ETH +6.24%.</p></div>
            <button className="lbtn primary" onClick={replay}>▶ Replay the day</button>
          </div>
          <ReplayChart plain={plain.series} berg={berg.series} progress={progress} />
          <div className="legend2" style={{ marginTop: 8 }}><span><i style={{ background: "var(--hot)" }} />plain AMM: ${plain.lossUsd.toFixed(2)}</span><span><i style={{ background: "var(--morpho)" }} />Iceberg λ {pct(lambda)}: ${berg.lossUsd.toFixed(2)}</span></div>
        </div>

        <div className="panel glass">
          <h3>The keeper's search</h3>
          <p className="sub">Every λ from 100% to the floor on the same day at {fee * 1e4} bps. Green is the λ the keeper would publish. Click a bar to try it.</p>
          <div className="sweep" role="group" aria-label="LP loss at each lambda">
            {sw.rows.map((r, i) => <button key={r.lambda} onClick={() => setLambda(r.lambda)} className={`${r === sw.best ? "best" : ""} ${Math.abs(r.lambda - lambda) < 0.005 ? "cur" : ""}`} title={`λ ${pct(r.lambda)}: ${r.lossBps.toFixed(3)} bps`}>
              <motion.span className="bar" initial={{ scaleY: 0 }} animate={{ scaleY: 1, height: `${(r.lossBps / maxSweep) * 100}%` }} transition={{ delay: i * 0.03, type: "spring", stiffness: 140, damping: 18 }} />
              {Math.round(r.lambda * 100)}</button>)}
          </div>
          <p className="muted" style={{ fontSize: 13, margin: "14px 0 0" }}>Best: λ {pct(sw.best.lambda)}, {((1 - sw.best.lossBps / sw.plain.lossBps) * 100).toFixed(1)}% less loss. On 7 days of real prices, the best λ at 30 bps is 100%: partial activity only pays at low fees.</p>
        </div>
      </div>
    </section>

    <section ref={hs} className="hscroll">
      <div ref={track} className="htrack">
        <div className="hcard" style={{ justifyContent: "center", flex: "0 0 min(520px, 84vw)" }}>
          <div className="kicker">One block, step by step</div>
          <h2 className="display h-m" style={{ marginTop: 20 }}>Two seconds in the life of the pool.</h2>
          <p className="t2" style={{ marginTop: 18 }}>Scroll →</p>
        </div>
        {STEPS.map((s, i) => <div key={i} className="hcard glass">
          <div className="no">STEP 0{i + 1}</div><h3>{s.t}</h3><p>{s.p}</p>
          <div className="viz"><StepViz kind={s.viz} lambda={lambda} /></div>
        </div>)}
      </div>
    </section>

    <section className="section wrap" style={{ paddingTop: 40 }}>
      <Reveal><div className="kicker">Inside one block</div></Reveal>
      <SplitText as="h2" text="A smaller curve, a smaller prize." className="display h-l" />
      <div className="curve-wrap">
        <div className="panel glass">
          <CurveViz lambda={lambda} jump={jump} />
          <label className="t2" style={{ fontSize: 14, display: "block", marginTop: 10 }}>ETH jumps <b className="tnum">+{(jump * 100).toFixed(0)}%</b> this block</label>
          <input aria-label="price jump" className="range" type="range" min={0.05} max={1} step={0.01} value={jump} onChange={e => setJump(Number(e.target.value))} style={{ ["--p" as any]: `${((jump - 0.05) / 0.95) * 100}%` }} />
        </div>
        <div className="panel glass">
          <h3>What the arbitrageur can take</h3>
          <p className="sub">Within a block and before fees, trading reserves (x, y) to a new price p₁ yields (√(p₁x) − √y)². Only λ·R is in the curve, so the prize scales by λ.</p>
          <div className="kv"><span className="k">whole pool exposed</span><span className="v hot">{profitFull.toFixed(4)} units</span></div>
          <div className="kv"><span className="k">Iceberg at λ {pct(lambda)}</span><span className="v tip">{profitAct.toFixed(4)} units</span></div>
          <div className="kv"><span className="k">kept from arbitrage this block</span><span className="v morpho">{pct(1 - profitAct / profitFull)}</span></div>
          <div style={{ marginTop: 30 }}>
            <h3>The paper's closed form</h3>
            <div className="formula">λ*(γ) = <span className="tip">(1 + √(1+2γ))</span> / <span className="frozen">(1 + γ + √(1+2γ))</span></div>
            <label className="t2" style={{ fontSize: 14 }}>γ = <b className="tnum">{gamma.toFixed(1)}</b> → λ* = <b className="tip tnum">{pct(lambdaStar(gamma), 1)}</b></label>
            <input aria-label="gamma" className="range" type="range" min={0} max={8} step={0.1} value={gamma} onChange={e => setGamma(Number(e.target.value))} style={{ ["--p" as any]: `${(gamma / 8) * 100}%` }} />
            <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>The on-chain kernel matches this to within 1e-16. The paper assumes zero fees; the keeper measures the fee instead.</p>
          </div>
        </div>
      </div>
    </section>
    <Footer />
  </main>;
}
