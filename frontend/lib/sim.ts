// The keeper's model (research/lambda_policy.mjs), in the browser: a 50/50 constant-product PA-AMM (Algorithm 1),
// arbitraged to each real 1-minute close. Each step the reserves split into λ active / (1 − λ) frozen, the arbitrageur
// trades the active curve to the fee band around the market price, then the two parts recombine.
import prices from "@/data/prices-2026-09-21.json";

export const PRICES: number[] = prices.p;
export const PRICE_T0: number = prices.t0;

export type Sim = { lossBps: number; lossUsd: number; series: number[]; arbUsd: number };

/** Loss vs a perfectly rebalanced 50/50 portfolio, for a $100k pool. `series` = cumulative loss in $, every `every` minutes. */
export function simulate(lambda: number, fee: number, S: number[] = PRICES, every = 10): Sim {
  let X = 50000 / S[0], Y = 50000, Vreb = 100000, arb = 0;
  const series: number[] = [0];
  for (let n = 1; n < S.length; n++) {
    const s = S[n];
    Vreb *= 0.5 * s / S[n - 1] + 0.5;
    let ax = lambda * X, ay = lambda * Y;
    const px = X - ax, py = Y - ay, k = ax * ay, p = ay / ax;
    if (p < s * (1 - fee)) {
      const pn = s * (1 - fee), ax2 = Math.sqrt(k / pn), dy = (Math.sqrt(k * pn) - ay) / (1 - fee);
      arb += (ax - ax2) * s - dy; ax = ax2; ay += dy;
    } else if (p > s / (1 - fee)) {
      const pn = s / (1 - fee), dx = (Math.sqrt(k / pn) - ax) / (1 - fee), ay2 = Math.sqrt(k * pn);
      arb += (ay - ay2) - dx * s; ax += dx; ay = ay2;
    }
    X = ax + px; Y = ay + py;
    if (n % every === 0 || n === S.length - 1) series.push(Vreb - (X * s + Y));
  }
  const loss = Vreb - (X * S[S.length - 1] + Y);
  return { lossBps: loss / 100000 * 1e4, lossUsd: loss, series, arbUsd: arb };
}

/** The keeper's search: every λ from 100% down to the floor, lowest loss wins. */
export function sweep(fee: number, floor = 0.4, step = 0.05) {
  const rows: { lambda: number; lossBps: number }[] = [];
  for (let l = 1; l >= floor - 1e-9; l -= step) rows.push({ lambda: Math.round(l * 100) / 100, lossBps: simulate(l, fee).lossBps });
  const best = rows.reduce((b, r) => (r.lossBps < b.lossBps - 1e-12 ? r : b), rows[0]);
  return { rows, best, plain: rows[0] };
}

/** Closed-form λ*(γ) from the paper. */
export const lambdaStar = (g: number) => (1 + Math.sqrt(1 + 2 * g)) / (1 + g + Math.sqrt(1 + 2 * g));

/** Within one block, no fee: arbitrage profit on reserves (x, y) when the price jumps to p1 is (√(p1·x) − √y)². */
export const arbProfit = (x: number, y: number, p1: number) => (Math.sqrt(p1 * x) - Math.sqrt(y)) ** 2;
