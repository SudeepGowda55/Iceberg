/* Live terminal view of everything happening on the fork (or mainnet): swaps on all three venues, per-block splits,
 * Morpho vault moves, parking, λ updates, rebalances, and each keeper tick. The same feed the UI shows.
 * NETWORK=local npx tsx scripts/watch.ts        (Ctrl+C to stop) */
import { fmt } from "../lib/iceberg";
import { icebergFor, labels, loadState } from "../lib/server";

const NET = process.env.NETWORK || "local";
const c = { d: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", o: "\x1b[38;5;208m", r: "\x1b[0m" };
const color: Record<string, string> = { "terminal / API": c.o, UI: c.c, keeper: c.g, "maker / keeper": c.g, "arbitrageur (simulated)": c.d };
const seen = new Set<string>();
let lastTick = -1, first = true;

(async () => {
  console.log(`watching Iceberg on ${NET} — swaps, splits, vault moves, parking, λ, rebalances, keeper ticks (Ctrl+C to stop)\n`);
  for (;;) {
    try {
      const b = icebergFor(NET);
      const a = await b.activity(b.dep.deployBlock || 0, labels(b.dep));
      const fresh = a.items.filter((i: any) => !seen.has(i.key)).reverse();
      for (const i of fresh) {
        seen.add(i.key);
        if (first) continue; // only print what happens from now on
        console.log(`${c.d}block ${i.block}${c.r}  ${(color[i.source] || "") + i.source.padEnd(24) + c.r} ${i.text} ${c.d}· tx ${i.tx.slice(0, 10)}…${c.r}`);
      }
      const ev = loadState(NET)?.events?.at(-1);
      if (ev && ev.tick !== lastTick) {
        if (!first) console.log(`${c.g}keeper tick ${ev.tick}${c.r}  live ETH $${fmt(ev.live?.ethUsd)} · λ ${ev.lambda != null ? fmt(ev.lambda * 100, 0) + "%" : "–"}${ev.policy ? ` (${fmt(ev.policy.savedPct, 1)}% less loss on the last ${ev.policy.minutes} min at ${ev.policy.feeBps} bps)` : ""}${ev.weightEthPct != null ? ` · Aqua ETH weight ${fmt(ev.weightEthPct, 2)}%` : ""}${ev.rebalance ? ` · ${c.y}REBALANCED${c.r}` : ""}`);
        lastTick = ev.tick;
      }
      if (first) { console.log(`${c.d}(${seen.size} earlier events skipped; new activity appears below)${c.r}`); first = false; }
    } catch (e: any) { console.log(`${c.d}(waiting for the stack: ${e.shortMessage || e.message})${c.r}`); }
    await new Promise(r => setTimeout(r, 2000));
  }
})();
