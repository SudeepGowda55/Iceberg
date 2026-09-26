// Reference vectors for IcebergMath, computed in float64 from the paper's formulas (arXiv 2602.09887).
// The Solidity fuzz/unit tests read research/vectors.json and assert agreement within a published error bound.
import fs from "fs";

const lambdaStar = g => (1 + Math.sqrt(1 + 2 * g)) / (1 + g + Math.sqrt(1 + 2 * g));
const v2Of = g => (g - 1 + Math.sqrt(1 + 2 * g)) / 2;
function theorem1(g, m, gap, lmin) {
  const base = lambdaStar(g);
  if (m === 0 || gap === 0) return Math.min(1, Math.max(lmin, base));
  const v2 = v2Of(g), v1 = g * v2 * m / ((1 + v2) * base);
  return Math.min(1, Math.max(lmin, base + (2 * v2 * m + v1) / (2 * (1 + v2)) / gap));
}
// check v2 closed form against the paper's fixed point v2 = γ - γ²/(4(1+v2))
for (const g of [0.1, 0.5, 2, 8, 30]) { const v = v2Of(g); if (Math.abs(v - (g - g * g / (4 * (1 + v)))) > 1e-12) throw new Error("v2 closed form mismatch at " + g); }

let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const wad = x => BigInt(Math.round(x * 1e18)).toString();
const out = { lambdaStar: [], theorem1: [], ln: [] };
for (const g of [0, 0.01, 0.1, 0.5, 1, 2, 4, 8, 16, 50]) out.lambdaStar.push({ gamma: wad(g), expect: wad(lambdaStar(g)) });
for (let i = 0; i < 40; i++) {
  const g = [0.5, 2, 8][i % 3], m = (rnd() - 0.5) * 2e-4, gap = (rnd() - 0.5) * 0.02 || 0.001, lmin = 0.1;
  out.theorem1.push({ gamma: wad(g), m: wad(m), gap: wad(gap), lmin: wad(lmin), expect: wad(theorem1(g, m, gap, lmin)) });
}
for (let i = 0; i < 40; i++) { const r = 0.5 + rnd() * 1.5; out.ln.push({ r: wad(r), expect: wad(Math.log(r)) }); }
fs.writeFileSync(new URL("./vectors.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote ${out.lambdaStar.length} lambdaStar, ${out.theorem1.length} theorem1, ${out.ln.length} ln vectors; v2 closed form verified against the paper's fixed point`);
