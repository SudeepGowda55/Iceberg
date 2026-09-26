/* Weight-tracking rebalance of the Aqua position from the terminal.
 * NETWORK=local|dryrun-base|mainnet [FORCE=1] [DEPLOYER_PK=...] npx tsx scripts/rebalance.ts */
import { fmt } from "../lib/iceberg";
import { rebalanceAqua } from "../lib/server";
(async () => {
  const r = await rebalanceAqua(process.env.NETWORK || "local", { force: process.env.FORCE === "1" });
  console.log(`ETH weight before ${fmt(r.weightBefore * 100, 2)}% (band 50% ± ${fmt(r.band * 100, 1)}%)`);
  if (!r.rebalanced) return console.log(`no rebalance: ${r.reason}`);
  for (const t of r.txs) console.log(`  ${t.what} · tx ${t.tx}`);
  console.log(`ETH weight after ${fmt(r.weightAfter * 100, 2)}% · new strategy ${r.newOrderHash} (salt ${r.salt})`);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
