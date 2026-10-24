"use client";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef } from "react";
import { CountUp, Magnetic, Marquee, Reveal, SplitText, Tilt } from "@/components/fx";
import { Footer } from "@/components/Shell";
import { resetScene, scene } from "@/lib/sceneStore";
import { sweep } from "@/lib/sim";
import { AQUA_STUDY } from "@/lib/site";

const IcebergScene = dynamic(() => import("@/components/IcebergScene"), { ssr: false });

const CHAPTERS = [
  { k: "01 · The problem", t: "A normal AMM leaves the whole pool exposed.", p: "Every time ETH moves, arbitrageurs trade the pool back to the market price, and their profit comes straight out of the LPs. In a real 24-hour replay, a plain Uniswap v4 pool lost $1.077 that way." },
  { k: "02 · The split", t: "Every block, Iceberg freezes 1 − λ of the reserves.", p: "On the first trade of a block the reserves split. Every trade in that block sees only λ·R, priced on a constant-product curve with a 5 bps fee. Quotes never write storage, so quote == swap.", right: true },
  { k: "03 · The yield", t: "The frozen part doesn't sit idle.", p: "Passive reserves are parked in Morpho vaults (Steakhouse USDC, Moonwell ETH) and pulled back out inside the swap, the moment a trade needs them. LPs can always exit." },
  { k: "04 · The keeper", t: "λ isn't a constant. It's chosen.", p: "Every ~10 minutes a fee-aware keeper replays the last 6 hours of real ETH/USD at the pool's fee, simulates every λ down to the floor, and publishes the one that loses least to both venues.", right: true, bars: true },
];

export default function Home() {
  const root = useRef<HTMLDivElement>(null), story = useRef<HTMLDivElement>(null);
  const hudL = useRef<HTMLSpanElement>(null), hudBar = useRef<HTMLSpanElement>(null), hudDot = useRef<HTMLElement>(null), hud = useRef<HTMLDivElement>(null);
  const sw = useMemo(() => sweep(0.0005), []);
  const maxLoss = Math.max(...sw.rows.map(r => r.lossBps));

  useLayoutEffect(() => {
    const S = innerWidth > 900 ? 0.2 : 0;
    resetScene({ lambda: 0.42, arb: 0.3, shift: S });
    const ctx = gsap.context(() => {
      // one scrubbed timeline across the story: each chapter is one unit
      const tl = gsap.timeline({ defaults: { ease: "none", duration: 1 }, scrollTrigger: { trigger: story.current, start: "top top", end: "bottom bottom", scrub: 1.1 } });
      tl.to(scene, { lambda: 1, danger: 1, arb: 1, zoom: 0.95, lift: 1.25, shift: S })            // 01 everything exposed
        .to(scene, { lambda: 0.5, danger: 0, arb: 0.4, zoom: 0, orbit: -0.6, lift: 0, shift: -S }) // 02 split
        .to(scene, { morpho: 1, orbit: 0.5, zoom: -0.2, lift: -0.55, shift: S })                 // 03 yield, camera dips
        .to(scene, { lambda: 0.39, orbit: 1.6, zoom: 0.15, lift: 0.1, arb: 0.3, shift: -S * 1.1 });      // 04 keeper
      // after the story, sink the scene back and dim it
      gsap.to(".berg-fixed", { opacity: 0.25, ease: "none", scrollTrigger: { trigger: ".after", start: "top bottom", end: "top 30%", scrub: true } });
      gsap.to(hud.current, { opacity: 0, ease: "none", scrollTrigger: { trigger: ".after", start: "top bottom", end: "top 60%", scrub: true } });
      gsap.utils.toArray<HTMLElement>(".chapter").forEach(el => {
        gsap.fromTo(el.querySelectorAll(".rv"), { y: 70, opacity: 0, filter: "blur(14px)" }, {
          y: 0, opacity: 1, filter: "blur(0px)", stagger: 0.1, duration: 1.1, ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 65%", end: "bottom 35%", toggleActions: "play reverse play reverse" },
        });
        gsap.fromTo(el.querySelector(".ch-num"), { yPercent: 40 }, { yPercent: -40, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } });
        const bars = el.querySelectorAll(".minibars div");
        if (bars.length) gsap.fromTo(bars, { scaleY: 0 }, { scaleY: 1, stagger: 0.05, duration: 0.8, ease: "back.out(1.6)", scrollTrigger: { trigger: el, start: "top 55%", toggleActions: "play none none reverse" } });
      });
      gsap.fromTo(".hero-inner", { opacity: 1, y: 0 }, { opacity: 0, y: -120, ease: "none", scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true } });
    }, root);
    // HUD mirrors the scene's live λ and the 2 s block clock
    let raf = 0;
    const loop = () => {
      if (hudL.current) hudL.current.textContent = `${Math.round(scene.lambda * 100)}%`;
      if (hudBar.current) hudBar.current.style.width = `${scene.lambda * 100}%`;
      if (hudDot.current) { const b = scene.blockPhase; hudDot.current.style.opacity = String(1 - b * 0.8); hudDot.current.style.transform = `scale(${1 + (1 - b) * 0.6})`; }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { ctx.revert(); cancelAnimationFrame(raf); ScrollTrigger.refresh(); };
  }, []);

  return <div ref={root}>
    <div className="berg-fixed"><IcebergScene /></div>
    <div className="scrim" />

    <div ref={hud} className="hud glass" aria-hidden>
      <div className="hud-row"><span>λ · reachable this block</span></div>
      <div className="hud-row" style={{ marginTop: 6 }}><span ref={hudL} className="hud-l tnum">42%</span><span className="t2">of reserves</span></div>
      <div className="hud-bar"><span ref={hudBar} style={{ width: "42%" }} /></div>
      <div className="hud-block"><i ref={hudDot} />new block every 2 s on Base</div>
    </div>

    <main className="above">
      <div ref={story}>
        <section className="hero wrap">
          <div className="hero-inner">
            <motion.div className="chips" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.8 }}>
              <span className="chip"><span className="live" />Live on Base mainnet</span>
              <span className="chip">ETHGlobal Tokyo 2026</span>
              <span className="chip"><span className="uni">Uniswap v4</span> · <span className="aqua">1inch Aqua</span></span>
            </motion.div>
            <SplitText text="Only the tip trades." className="display h-xl" delay={0.75} />
            <Reveal delay={1.3}><p className="lede">A Partially Active AMM. In any block, arbitrageurs can reach only a fraction <span className="tip serif i" style={{ fontSize: "1.3em" }}>λ</span> of the reserves. The rest stays frozen below the waterline, and earns yield in Morpho.</p></Reveal>
            <Reveal delay={1.5}><div className="ctas">
              <Magnetic href="/mechanism" className="btn btn-ice">Play with λ <span aria-hidden>→</span></Magnetic>
              <Magnetic href="/evidence" className="btn btn-ghost">See the evidence</Magnetic>
            </div></Reveal>
          </div>
          <div className="scroll-cue wrap"><i />Scroll to sink it</div>
        </section>

        {CHAPTERS.map((c, i) => <section key={i} className={`chapter wrap ${c.right ? "right" : ""}`} style={{ position: "relative" }}>
          <div className="ch-num" aria-hidden style={c.right ? { left: 0, right: "auto" } : {}}>{String(i + 1).padStart(2, "0")}</div>
          <div className="body">
            <div className="kicker rv">{c.k}</div>
            <h2 className="display h-m rv" style={{ margin: "22px 0 0" }}>{c.t}</h2>
            <p className="rv">{c.p}</p>
            {i === 1 && <div className="legend-dots rv"><span><i style={{ background: "var(--tip)" }} />active · λ·R</span><span><i style={{ background: "var(--frozen)" }} />frozen · (1 − λ)·R</span></div>}
            {i === 2 && <div className="legend-dots rv"><span><i style={{ background: "var(--morpho)" }} />earning in Morpho</span><span className="t2">unparked mid-swap when needed</span></div>}
            {c.bars && <div className="rv">
              <div className="minibars" role="img" aria-label={`Loss at each λ on 21 Sep at 5 bps; best λ ${Math.round(sw.best.lambda * 100)}%`}>
                {sw.rows.map(r => <div key={r.lambda} className={r === sw.best ? "best" : ""} style={{ height: `${(r.lossBps / maxLoss) * 100}%` }}><span>{Math.round(r.lambda * 100)}</span></div>)}
              </div>
              <p style={{ fontSize: 14, marginTop: 36 }} className="muted">The keeper's search, re-run in your browser on the real 21 Sep prices at 5 bps: λ {Math.round(sw.best.lambda * 100)}% loses {((1 - sw.best.lossBps / sw.plain.lossBps) * 100).toFixed(1)}% less than fully active.</p>
            </div>}
          </div>
        </section>)}
      </div>

      <div className="after">
        <section className="section wrap">
          <Reveal><div className="kicker">Measured, not modelled</div></Reveal>
          <SplitText as="h2" text="On the real 24 hours of 21 Sep, LPs lost less." className="display h-l" />
          <div className="stats">
            {[
              { n: <CountUp to={17.6} decimals={1} prefix="−" suffix="%" />, d: "less LP loss to arbitrage at λ 50%, vs a real plain Uniswap v4 pool at the same 5 bps fee", c: "grad-m" },
              { n: <CountUp to={19.3} decimals={1} prefix="−" suffix="%" />, d: "at λ 39%. 1,440 one-minute steps on a Base mainnet fork, real PoolManager and official Aqua", c: "grad-m" },
              { n: <CountUp to={52} />, d: "Solidity tests, including 22 fork tests against the real Base contracts", c: "grad" },
              { n: <CountUp to={0.2} decimals={2} prefix="$" />, d: "of gas for the full 64-transaction mainnet flow, rehearsed on a fork first", c: "grad" },
              { n: <CountUp to={0} />, d: "wei of price difference between the Aqua position and the v4 hook at the same λ and fee", c: "grad" },
              { n: <CountUp to={AQUA_STUDY.neverFilledPct} decimals={1} suffix="%" />, d: `of the ${AQUA_STUDY.strategies} Aqua strategies on Base never got a single fill. Idle liquidity is the default`, c: "hot" },
            ].map((s, i) => <Reveal key={i} delay={(i % 3) * 0.08} className="stat"><div className={`n ${s.c}`}>{s.n}</div><div className="d">{s.d}</div></Reveal>)}
          </div>
        </section>

        <section className="section wrap" style={{ paddingTop: 0 }}>
          <Reveal><div className="kicker">One kernel, two venues</div></Reveal>
          <SplitText as="h2" text="Same reserves. Same λ. Same price, to the wei." className="display h-l" />
          <div className="venues">
            <Reveal><Tilt className="venue glass">
              <div className="glow" style={{ background: "var(--uni)" }} />
              <span className="chip"><span className="uni">●</span> Uniswap v4</span>
              <h3>IcebergHook</h3>
              <p>A hook on OpenZeppelin's BaseCustomCurve that owns the reserves as ERC-6909 claims. Each block the passive part freezes; idle reserves are parked in Morpho and unparked inside the swap.</p>
              <ul><li><b>Pricing</b>x·y = k on the active reserves only</li><li><b>Idle funds</b>parked in Morpho, never more than 1 − max λ</li><li><b>Address</b><span className="mono">0xe5a6…eA88</span></li></ul>
            </Tilt></Reveal>
            <Reveal delay={0.1}><Tilt className="venue glass">
              <div className="glow" style={{ background: "var(--aqua)" }} />
              <span className="chip"><span className="aqua">●</span> 1inch Aqua · SwapVM</span>
              <h3>PAActiveReserves <span className="mono muted" style={{ fontSize: 18 }}>0x92</span></h3>
              <p>A SwapVM instruction in a free opcode slot, followed by 1inch's stock FeeFlatIn and XYCSwap. The maker holds only Morpho vault shares; each fill withdraws exactly what it needs.</p>
              <ul><li><b>Program</b>Salt → guard → PAActiveReserves → FeeFlatIn → XYCSwap</li><li><b>Shared liquidity</b>the same vault shares back a strategy on 1inch's official router</li><li><b>Address</b><span className="mono">0xE498…84b5</span></li></ul>
            </Tilt></Reveal>
          </div>
          <Reveal><div className="parity glass">
            <div className="eq">quote<sub className="mono" style={{ fontSize: 13 }}>v4</sub> <span className="tip">==</span> quote<sub className="mono" style={{ fontSize: 13 }}>aqua</sub></div>
            <div className="vals"><span>LP loss λ 50%, hook: <b className="morpho">$0.888</b></span><span>LP loss λ 50%, Aqua: <b className="morpho">$0.888</b></span></div>
          </div></Reveal>
        </section>

        <Marquee items={["Uniswap v4", "1inch Aqua", "SwapVM", "Morpho", "Chainlink", "Base", "OpenZeppelin hooks", "Foundry"]} />

        <section className="section wrap">
          <Reveal><div className="kicker">Go deeper</div></Reveal>
          <SplitText as="h2" text="Pick a way in." className="display h-l" />
          <div className="paths">
            {[
              { href: "/mechanism", t: "Mechanism", p: "Drag λ, change the fee, replay the real day in your browser.", c: "var(--tip)" },
              { href: "/evidence", t: "Evidence", p: "The fork replay, the tests, the Aqua-on-Base study, with the command for each.", c: "var(--morpho)" },
              { href: "/live", t: "Live", p: "Both venues, the keeper's last decision, real swaps, the on-chain feed.", c: "var(--uni)" },
              { href: "/contracts", t: "Contracts", p: "Every Base mainnet address and the transactions that prove it trades.", c: "var(--aqua)" },
            ].map((x, i) => <Reveal key={x.href} delay={i * 0.07}><Tilt className="glass" style={{ borderRadius: "var(--r)" }}>
              <Link href={x.href} className="path" data-cursor>
                <div><div className="t" style={{ color: x.c }}>{x.t}</div><p>{x.p}</p></div>
                <div className="go"><span>0{i + 1}</span><span className="arrow">→</span></div>
              </Link>
            </Tilt></Reveal>)}
          </div>
        </section>
        <Footer />
      </div>
    </main>
  </div>;
}
