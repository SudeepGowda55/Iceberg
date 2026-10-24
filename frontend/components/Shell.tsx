"use client";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NAV, REPO } from "@/lib/site";

gsap.registerPlugin(ScrollTrigger);

/** Lenis smooth scroll, driven by GSAP's ticker so ScrollTrigger scrubs stay in sync. */
export function SmoothScroll() {
  const path = usePathname();
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.09, anchors: { offset: -90 } });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tick); gsap.ticker.lagSmoothing(0);
    (window as any).__lenis = lenis;
    return () => { gsap.ticker.remove(tick); lenis.destroy(); };
  }, []);
  useEffect(() => { (window as any).__lenis?.scrollTo(0, { immediate: true }); requestAnimationFrame(() => ScrollTrigger.refresh()); }, [path]);
  return null;
}

export function BergMark({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="mark">
    <path d="M12 3 L16 9 L14.5 10.5 L19 13 H5 L8.5 8 L10 9.5 Z" fill="currentColor" />
    <path d="M5 13 H19 L16 20 L12 22 L7.5 19.5 Z" fill="currentColor" opacity=".35" />
    <path d="M3 13 H21" stroke="var(--tip)" strokeWidth="1.4" />
  </svg>;
}

export function Nav() {
  const path = usePathname();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { const f = () => setScrolled(scrollY > 40); f(); addEventListener("scroll", f, { passive: true }); return () => removeEventListener("scroll", f); }, []);
  const active = (h: string) => (h === "/" ? path === "/" : path.startsWith(h));
  return <motion.header className={`nav ${scrolled ? "scrolled" : ""}`} initial={{ y: -80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.9, delay: 0.6, ease: [0.22, 1, 0.36, 1] }}>
    <Link href="/" className="nav-brand"><BergMark />Iceberg</Link>
    <nav className="nav-links">
      {NAV.map(n => <Link key={n.href} href={n.href} className={active(n.href) ? "on" : ""}>
        {active(n.href) && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: "spring", stiffness: 380, damping: 32 }} />}
        <span className="nav-label">{n.label}</span>
      </Link>)}
    </nav>
    <a className="nav-gh" href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub repository">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" /></svg>
    </a>
  </motion.header>;
}

export function Footer() {
  return <footer className="foot wrap">
    <div className="foot-big" aria-hidden>ICEBERG</div>
    <div className="foot-row">
      <span>Partially Active AMM (Ko 2026, <a href="https://arxiv.org/abs/2602.09887" target="_blank" rel="noreferrer">arXiv 2602.09887</a>) on 1inch Aqua & Uniswap v4 · Base mainnet</span>
      <span>Built at ETHGlobal Tokyo 2026 · <a href={REPO} target="_blank" rel="noreferrer">GitHub ↗</a></span>
    </div>
  </footer>;
}
