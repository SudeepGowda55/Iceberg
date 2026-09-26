// Step 1: does the paper's Theorem 1 policy lambda(g) beat a fixed lambda on real ETH prices?
// Model: 50/50 constant-product PA-AMM (Algorithm 1), arbitraged to the real Coinbase ETH/USD 1-minute close each step.
// Theorem 1: lambda(g) = clip(1 - gamma/(2(1+b v2)) + b(2 v2 m + v1)/(2(1+b v2)) * 1/g, lmin, 1)
//   v2 = gamma - gamma^2/(4(1+b v2)),  v1 = gamma*b*(2 v2 m + v1)/(2(1+b v2)),  m = mu*dt (drift per step)
import fs from "fs";
const S = JSON.parse(fs.readFileSync("eth_usd_1m_2026-09-19_to_26.json")).map(x => x[1]);
const b = 1 - 1e-6; // discount per step (rho -> 0)
function v2Of(g) { let v = g; for (let i = 0; i < 200; i++) v = g - g * g / (4 * (1 + b * v)); return v; }
function thm1(gamma, m, g, lmin) {
  const v2 = v2Of(gamma), den = 1 - gamma * b / (2 * (1 + b * v2)), v1 = den === 0 ? 0 : (gamma * b * 2 * v2 * m / (2 * (1 + b * v2))) / den;
  const base = 1 - gamma / (2 * (1 + b * v2)), tilt = Math.abs(g) < 1e-9 ? 0 : b * (2 * v2 * m + v1) / (2 * (1 + b * v2)) / g;
  return Math.min(1, Math.max(lmin, base + tilt));
}
const lambdaStar = gm => (1 + Math.sqrt(1 + 2 * gm)) / (1 + gm + Math.sqrt(1 + 2 * gm));
function run(policy, f) {
  let X = 50000 / S[0], Y = 50000, Vreb = 100000, arb = 0, fees = 0, te = 0, mu = 0; const lams = [];
  for (let n = 1; n < S.length; n++) {
    const s = S[n], r = Math.log(s / S[n - 1]); Vreb *= 0.5 * s / S[n - 1] + 0.5; mu = 0.98 * mu + 0.02 * r; // EWMA drift estimate (~50 min)
    const pPool = Y / X, g = Math.log(s / pPool), lam = policy(g, mu); lams.push(lam);
    let ax = lam * X, ay = lam * Y; const px = X - ax, py = Y - ay, k = ax * ay, p = ay / ax;
    if (p < s * (1 - f)) { const pn = s * (1 - f), ax2 = Math.sqrt(k / pn), dyE = Math.sqrt(k * pn) - ay, dy = dyE / (1 - f); arb += (ax - ax2) * s - dy; fees += dy - dyE; ax = ax2; ay += dy; }
    else if (p > s / (1 - f)) { const pn = s / (1 - f), axE = Math.sqrt(k / pn), dxE = axE - ax, dx = dxE / (1 - f), ay2 = Math.sqrt(k * pn); arb += (ay - ay2) - dx * s; fees += (dx - dxE) * s; ax += dx; ay = ay2; }
    X = ax + px; Y = ay + py; const w = X * s / (X * s + Y); te += (w - 0.5) ** 2;
  }
  const V = X * S.at(-1) + Y, lm = lams.reduce((a, x) => a + x, 0) / lams.length;
  return { loss: (Vreb - V) / 100000 * 1e4, te: te / S.length * 1e6, lamMean: lm, lamMin: Math.min(...lams), lamMax: Math.max(...lams) };
}
const out = [];
for (const f of [0.0001, 0.0005, 0.003]) {
  console.log(`\nfee ${f * 1e4} bps | 50/50 pool, 7 days real ETH/USD (10,081 min) | loss = bps vs perfectly rebalanced 50/50 (lower better) | TE = mean sq weight deviation x1e6`);
  const base = run(() => 1, f); console.log(`  plain curve (λ=1)                   loss ${base.loss.toFixed(2).padStart(6)}  TE ${base.te.toFixed(2)}`);
  for (const gamma of [0.5, 2, 8]) {
    const ls = lambdaStar(gamma), fx = run(() => ls, f), th = run((g, mu) => thm1(gamma, mu, g, 0.1), f);
    const row = { f, gamma, lambdaStar: ls, fixed: fx, thm1: th, plain: base };
    out.push(row);
    console.log(`  γ=${gamma}: fixed λ*=${ls.toFixed(3)}  loss ${fx.loss.toFixed(2).padStart(6)} (${((1 - fx.loss / base.loss) * 100).toFixed(0)}% vs plain) TE ${fx.te.toFixed(2)} | Theorem-1 λ(g): loss ${th.loss.toFixed(2).padStart(6)} (${((1 - th.loss / base.loss) * 100).toFixed(0)}%) TE ${th.te.toFixed(2)} λ mean ${th.lamMean.toFixed(3)} range [${th.lamMin.toFixed(2)},${th.lamMax.toFixed(2)}]  => λ(g) ${th.loss < fx.loss ? "BETTER" : "not better"} than fixed by ${(fx.loss - th.loss).toFixed(3)} bps`);
  }
}
fs.writeFileSync("lambda_policy_results.json", JSON.stringify(out, null, 1));
