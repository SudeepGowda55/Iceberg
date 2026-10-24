"use client";
import { motion, useScroll, useSpring } from "motion/react";
import { useRef, useState } from "react";
import { Reveal, SplitText, Tilt } from "@/components/fx";
import { Footer } from "@/components/Shell";
import { BUILT_ON, CONTRACTS, MAINNET_TXS, scan } from "@/lib/site";
import { short } from "@/lib/ui";

const TAG: Record<string, [string, string]> = { aqua: ["1inch Aqua", "aqua"], uni: ["Uniswap v4", "uni"], keeper: ["Keeper", "tip"], morpho: ["Morpho", "morpho"] };

function CopyAddr({ a }: { a: string }) {
  const [ok, setOk] = useState(false);
  return <button className="copy" aria-label={`copy ${a}`} onClick={() => { navigator.clipboard?.writeText(a); setOk(true); setTimeout(() => setOk(false), 1400); }}>
    <motion.span key={String(ok)} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} style={{ display: "inline-block" }}>{ok ? "copied ✓" : "copy"}</motion.span></button>;
}

export default function Contracts() {
  const tl = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: tl, offset: ["start 75%", "end 55%"] });
  const rail = useSpring(scrollYProgress, { stiffness: 120, damping: 24 });
  return <main className="above">
    <section className="phead wrap">
      <Reveal><div className="kicker">Base mainnet · chain 8453</div></Reveal>
      <SplitText text="Deployed. Trading. Verifiable." className="display h-l" />
      <Reveal delay={0.3}><p className="lede">Both venues are live with one wallet, and every transaction succeeded. Each address links to Basescan.</p></Reveal>
    </section>

    <section className="wrap">
      <div className="ctable">
        {CONTRACTS.map((c, i) => { const [tag, cls] = TAG[c.venue]; return <Reveal key={c.addr} delay={i * 0.05}><Tilt className="glass crow" max={3} style={{ borderRadius: 18 }}>
          <span className="ix">{String(i + 1).padStart(2, "0")}</span>
          <div><div className="nm">{c.name}</div><span className={`tag ${cls}`}>{tag}</span></div>
          <div className="wh">{c.what}</div>
          <div className="ad"><a href={scan(c.addr)} target="_blank" rel="noreferrer">{short(c.addr)} ↗</a><CopyAddr a={c.addr} /></div>
        </Tilt></Reveal>; })}
      </div>
    </section>

    <section className="section wrap">
      <Reveal><div className="kicker">The proof, in order</div></Reveal>
      <SplitText as="h2" text="Five transactions that show it works." className="display h-l" />
      <div ref={tl} className="timeline">
        <div className="rail"><motion.span style={{ scaleY: rail }} /></div>
        {MAINNET_TXS.map((t, i) => <Reveal key={t.tx} delay={0.05}><div className="tl-item">
          <div className="mono muted" style={{ fontSize: 12, letterSpacing: ".12em" }}>TX 0{i + 1}</div>
          <div className="w">{t.what}</div>
          <a href={scan(t.tx)} target="_blank" rel="noreferrer">{short(t.tx)} on Basescan ↗</a>
        </div></Reveal>)}
      </div>
    </section>

    <section className="section wrap" style={{ paddingTop: 0 }}>
      <Reveal><div className="kicker">Built on, unmodified</div></Reveal>
      <SplitText as="h2" text="Real contracts underneath." className="display h-m" />
      <div className="built">
        {BUILT_ON.map((b, i) => <Reveal key={b.addr} delay={i * 0.05}><a className="glass" style={{ borderRadius: 16 }} href={scan(b.addr)} target="_blank" rel="noreferrer">
          <b style={{ fontWeight: 500 }}>{b.name}</b><span>{short(b.addr)} ↗</span></a></Reveal>)}
      </div>
      <Reveal><p className="muted" style={{ fontSize: 14, marginTop: 24 }}>Source-verified on Base: <span className="mono">./scripts/verify_contracts.sh</span> · all addresses in <span className="mono">deployments/mainnet.json</span></p></Reveal>
    </section>
    <Footer />
  </main>;
}
