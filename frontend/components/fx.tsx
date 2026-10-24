"use client";
// Motion primitives shared by every page.
import { animate, motion, useInView, useMotionValue, useSpring, useTransform } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Headline that rises in word by word, each word clipped by its own mask. */
export function SplitText({ text, className = "", delay = 0, as: Tag = "h1", stagger = 0.06 }:
  { text: string; className?: string; delay?: number; as?: "h1" | "h2" | "h3" | "p"; stagger?: number }) {
  const ref = useRef<HTMLHeadingElement>(null), inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const words = text.split(" ");
  return <Tag ref={ref} className={`split ${className}`} aria-label={text}>
    {words.map((w, i) => <span key={i} className="split-mask" aria-hidden>
      <motion.span className="split-word" initial={{ y: "110%", rotate: 4 }} animate={inView ? { y: "0%", rotate: 0 } : {}}
        transition={{ duration: 1, ease: EASE, delay: delay + i * stagger }}>{w}</motion.span></span>).flatMap((m, i) => (i ? [" ", m] : [m]))}
  </Tag>;
}

/** Fade + rise + unblur when scrolled into view. */
export function Reveal({ children, delay = 0, y = 40, className = "", once = true }: { children: React.ReactNode; delay?: number; y?: number; className?: string; once?: boolean }) {
  return <motion.div className={className} initial={{ opacity: 0, y, filter: "blur(10px)" }} whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    viewport={{ once, margin: "-8% 0px" }} transition={{ duration: 0.9, ease: EASE, delay }}>{children}</motion.div>;
}

/** Number that counts up the first time it is seen. */
export function CountUp({ to, decimals = 0, prefix = "", suffix = "", duration = 2 }: { to: number; decimals?: number; prefix?: string; suffix?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null), inView = useInView(ref, { once: true });
  useEffect(() => {
    if (!inView || !ref.current) return;
    const c = animate(0, to, { duration, ease: [0.16, 1, 0.3, 1], onUpdate: v => { if (ref.current) ref.current.textContent = prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix; } });
    return () => c.stop();
  }, [inView, to, decimals, prefix, suffix, duration]);
  return <span ref={ref} className="tnum">{prefix}{(0).toFixed(decimals)}{suffix}</span>;
}

/** Number that tweens smoothly whenever its value changes (live data). */
export function Tween({ value, format }: { value: number | null | undefined; format: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null), last = useRef<number | null>(null);
  useEffect(() => {
    if (value == null || !Number.isFinite(value) || !ref.current) return;
    const from = last.current ?? value; last.current = value;
    const c = animate(from, value, { duration: 0.9, ease: EASE, onUpdate: v => { if (ref.current) ref.current.textContent = format(v); } });
    return () => c.stop();
  }, [value, format]);
  return <span ref={ref} className="tnum">{value == null ? "–" : format(value)}</span>;
}

/** Card that tilts towards the pointer with a spotlight under it. */
export function Tilt({ children, className = "", max = 9, style }: { children: React.ReactNode; className?: string; max?: number; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0.5), my = useMotionValue(0.5);
  const rx = useSpring(useTransform(my, [0, 1], [max, -max]), { stiffness: 180, damping: 18 });
  const ry = useSpring(useTransform(mx, [0, 1], [-max, max]), { stiffness: 180, damping: 18 });
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    mx.set(x); my.set(y); ref.current!.style.setProperty("--sx", `${x * 100}%`); ref.current!.style.setProperty("--sy", `${y * 100}%`);
  };
  return <motion.div ref={ref} className={`tilt ${className}`} style={{ rotateX: rx, rotateY: ry, transformPerspective: 900, ...style }}
    onPointerMove={onMove} onPointerLeave={() => { mx.set(0.5); my.set(0.5); }}>{children}<span className="spot" aria-hidden /></motion.div>;
}

/** Link/button that leans towards the pointer. */
export function Magnetic({ children, href, className = "", strength = 0.35, onClick }: { children: React.ReactNode; href?: string; className?: string; strength?: number; onClick?: () => void }) {
  const x = useSpring(0, { stiffness: 220, damping: 15 }), y = useSpring(0, { stiffness: 220, damping: 15 });
  const onMove = (e: React.PointerEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); x.set((e.clientX - r.left - r.width / 2) * strength); y.set((e.clientY - r.top - r.height / 2) * strength); };
  const reset = () => { x.set(0); y.set(0); };
  const inner = <motion.span style={{ x, y, display: "inline-flex" }}>{children}</motion.span>;
  const ext = href?.startsWith("http");
  return href
    ? <Link href={href} className={`mag ${className}`} onPointerMove={onMove} onPointerLeave={reset} {...(ext ? { target: "_blank", rel: "noreferrer" } : {})}>{inner}</Link>
    : <button className={`mag ${className}`} onPointerMove={onMove} onPointerLeave={reset} onClick={onClick}>{inner}</button>;
}

export function Marquee({ items, speed = 40 }: { items: string[]; speed?: number }) {
  const row = [...items, ...items];
  return <div className="marquee" aria-label={items.join(", ")}>
    <div className="marquee-track" style={{ animationDuration: `${speed}s` }} aria-hidden>{row.map((t, i) => <span key={i}>{t}<i>✦</i></span>)}</div>
  </div>;
}

/** Ring that trails the pointer and swells over anything clickable (fine pointers only). */
export function Cursor() {
  const ring = useRef<HTMLDivElement>(null), dot = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!matchMedia("(pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setOn(true);
    let x = innerWidth / 2, y = innerHeight / 2, rx = x, ry = y, raf = 0;
    const move = (e: PointerEvent) => {
      x = e.clientX; y = e.clientY;
      ring.current?.classList.toggle("hot", !!(e.target as Element)?.closest?.("a,button,input,select,[data-cursor]"));
    };
    const loop = () => {
      rx += (x - rx) * 0.16; ry += (y - ry) * 0.16;
      if (ring.current) ring.current.style.transform = `translate3d(${rx}px,${ry}px,0)`;
      if (dot.current) dot.current.style.transform = `translate3d(${x}px,${y}px,0)`;
      raf = requestAnimationFrame(loop);
    };
    addEventListener("pointermove", move, { passive: true }); loop();
    return () => { removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, []);
  if (!on) return null;
  return <><div ref={ring} className="cursor-ring" aria-hidden /><div ref={dot} className="cursor-dot" aria-hidden /></>;
}
