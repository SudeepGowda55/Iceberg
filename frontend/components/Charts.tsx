"use client";
import { useRef, useState } from "react";
import { fmt, HEX } from "@/lib/ui";

type Pt = { x: number; y: number };
type Series = { name: string; color: string; points: Pt[]; zero?: boolean };

export function LineChart({ series, yFmt = (v: number) => fmt(v), step = false, height = 230 }:
  { series: Series[]; yFmt?: (v: number) => string; step?: boolean; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ sx: number; xv: number; left: number } | null>(null);
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return <div className="empty">no data yet</div>;
  const W = 640, H = height, L = 60, R = 16, T = 10, B = 26;
  let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)); if (x1 === x0) x1 = x0 + 1;
  let y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
  const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.01 || 1; y0 -= pad; y1 += pad;
  if (series.some(s => s.zero)) y0 = Math.min(0, y0);
  const X = (x: number) => L + (x - x0) / (x1 - x0) * (W - L - R), Y = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const xFmt = (t: number) => new Date(t * 1000).toLocaleTimeString();
  const path = (s: Series) => s.points.map((q, i) => i === 0 ? `M${X(q.x)},${Y(q.y)}` : step ? `H${X(q.x)}V${Y(q.y)}` : `L${X(q.x)},${Y(q.y)}`).join("") + (step ? `H${X(x1)}` : "");
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W;
    setHover({ sx, xv: x0 + (sx - L) / (W - L - R) * (x1 - x0), left: e.clientX - r.left });
  };
  const valueAt = (s: Series, xv: number) => { let b: Pt | null = null; for (const q of s.points) if (q.x <= xv + 1e-9) b = q; return b || (!step ? s.points[0] : null); };
  return (
    <div className="chart">
      {series.length > 1 && <div className="legend">{series.map(s => <span key={s.name}><span className="dot" style={{ background: s.color }} />{s.name}</span>)}</div>}
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`}>
        {[0, 1, 2, 3, 4].map(i => { const v = y0 + (y1 - y0) * i / 4; return <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--grid)" /><text x={L - 8} y={Y(v) + 4} textAnchor="end" fill="var(--muted)" fontSize="11">{yFmt(v)}</text></g>; })}
        {[0, 1, 2, 3].map(i => { const v = x0 + (x1 - x0) * i / 3; return <text key={i} x={X(v)} y={H - 6} textAnchor="middle" fill="var(--muted)" fontSize="11">{xFmt(v)}</text>; })}
        {series.filter(s => s.points.length).map(s => { const last = s.points[s.points.length - 1]; return <g key={s.name}>
          <path d={path(s)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
          <circle cx={step ? X(x1) : X(last.x)} cy={Y(last.y)} r="4" fill={s.color} stroke="var(--panel)" strokeWidth="2" /></g>; })}
        {hover && <line x1={hover.sx} x2={hover.sx} y1={T} y2={H - B} stroke="var(--text2)" strokeDasharray="3 3" />}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover && <div className="tip" style={{ display: "block", left: Math.max(0, hover.left + 12), top: 30 }}>
        <div className="muted">{xFmt(hover.xv)}</div>
        {series.map(s => { const v = valueAt(s, hover.xv); return v ? <div key={s.name}><span className="dot" style={{ background: s.color }} />{s.name}: <b>{yFmt(v.y)}</b></div> : null; })}
      </div>}
    </div>
  );
}

export function BarChart({ bars, vFmt = (v: number) => fmt(v, 0), height = 210 }:
  { bars: { label: string; v: number; color: string }[]; vFmt?: (v: number) => string; height?: number }) {
  if (!bars.length || bars.every(b => !b.v)) return <div className="empty">no data yet</div>;
  const W = 640, H = height, L = 48, R = 14, T = 20, B = 30, max = Math.max(...bars.map(b => b.v)) || 1;
  const slot = (W - L - R) / bars.length, bw = Math.min(110, slot * 0.55);
  return (
    <div className="chart"><svg viewBox={`0 0 ${W} ${H}`}>
      {[0, 1, 2, 3].map(i => { const v = max * i / 3, y = T + (1 - v / max) * (H - T - B); return <g key={i}><line x1={L} x2={W - R} y1={y} y2={y} stroke="var(--grid)" /><text x={L - 8} y={y + 4} textAnchor="end" fill="var(--muted)" fontSize="11">{vFmt(v)}</text></g>; })}
      {bars.map((b, i) => {
        const h = Math.max(1, b.v / max * (H - T - B)), x = L + slot * i + (slot - bw) / 2, y = H - B - h, r = Math.min(4, h);
        return <g key={b.label}>
          <path d={`M${x},${H - B} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - B} Z`} fill={b.color}><title>{`${b.label}: ${vFmt(b.v)}`}</title></path>
          <text x={x + bw / 2} y={y - 6} textAnchor="middle" fill="var(--text)" fontSize="12">{vFmt(b.v)}</text>
          <text x={x + bw / 2} y={H - 10} textAnchor="middle" fill="var(--text2)" fontSize="12">{b.label}</text></g>;
      })}
    </svg></div>
  );
}

export function Flow({ makers, hot }: { makers: { name: string }[]; hot: number | null }) {
  const on = (id: string) => hot !== null && (["t", "p", "h", "r"].includes(id) || id === `w${hot}`);
  const edgeOn = (id: string) => hot !== null && (["t-p", "p-h", "h-r"].includes(id) || id === `r-w${hot}`);
  const Node = ({ id, x, y, w, t, sub }: any) => <g className={`node ${on(id) ? "hot" : ""}`}><rect x={x} y={y} width={w} height={62} rx={12} /><text x={x + 14} y={y + 26}>{t}</text><text className="sub" x={x + 14} y={y + 46}>{sub}</text></g>;
  const Edge = ({ id, d }: any) => <path className={`edge ${edgeOn(id) ? "hot" : ""}`} d={d} />;
  return (
    <svg viewBox="0 0 1200 350" role="img" aria-label="Swap routing diagram">
      <Edge id="t-p" d="M170,160 H225" /><Edge id="p-h" d="M395,160 H450" /><Edge id="h-r" d="M640,160 H695" /><Edge id="cl-r" d="M800,290 V195" />
      {[0, 1, 2].map(i => <Edge key={i} id={`r-w${i}`} d={`M905,160 C950,160 950,${68 + i * 98} 990,${68 + i * 98}`} />)}
      <Node id="t" x={20} y={129} w={150} t="Trader" sub="any Uniswap user" />
      <Node id="p" x={225} y={129} w={170} t={<><tspan fill="var(--uni)">Uniswap v4</tspan> pool</>} sub="WETH/USDC, no own liquidity" />
      <Node id="h" x={450} y={129} w={190} t="WalletIndex hook" sub="best quote of all wallets" />
      <Node id="r" x={695} y={129} w={210} t={<><tspan fill="var(--aqua)">SwapVM</tspan> router</>} sub="1inch opcodes + opcode 34" />
      <Node id="cl" x={695} y={290} w={210} t="Chainlink ETH & BTC" sub="fresh, or no quote at all" />
      {makers.slice(0, 3).map((m, i) => { const y = 37 + i * 98; return <g key={m.name} className={`node ${on(`w${i}`) ? "hot" : ""}`}>
        <rect x={990} y={y} width={190} height={62} rx={12} /><circle cx={1008} cy={y + 26} r={6} fill={HEX[i]} />
        <text x={1022} y={y + 31}>{m.name}&apos;s wallet</text><text className="sub" x={1022} y={y + 49}>via <tspan fill="var(--aqua)">1inch Aqua</tspan></text></g>; })}
      <text x={990} y={340} fill="var(--good)" fontSize="13">agent retunes the wallets on-chain</text>
    </svg>
  );
}
