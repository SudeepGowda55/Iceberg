/* One real swap on any venue from the terminal.
 * NETWORK=local|dryrun-base|mainnet npx tsx scripts/swap.ts <v4|aqua|official> <buy|sell> <usd>
 * Local fork: signed by the CLI test key. Other networks: signed by DEPLOYER_PK. */
import { ethers } from "ethers";
import { fmt, Venue } from "../lib/iceberg";
import { apiQuote, apiSwap, icebergFor, wallet } from "../lib/server";
(async () => {
  const [venue = "v4", side = "buy", usd = "5"] = process.argv.slice(2) as [Venue, "buy" | "sell", string];
  const net = process.env.NETWORK || "local";
  const b = icebergFor(net);
  if (b.dep.keys?.cli) { const r = await apiSwap(net, venue, side, Number(usd)); return console.log(`${r.message} · price $${fmt(r.price)} vs oracle $${fmt(r.oracle)} · tx ${r.tx}`); }
  const pk = process.env.DEPLOYER_PK; if (!pk) throw new Error("set DEPLOYER_PK");
  const q = await apiQuote(net, venue, side, Number(usd));
  const amountIn = side === "buy" ? BigInt(Math.round(Number(usd) * 1e6)) : BigInt(Math.round(q.amountIn * 1e18));
  const rc = await (await b.swapTx(wallet(pk, b), venue, side, amountIn)).wait();
  console.log(`${q.venue}: ${side} ${fmt(side === "buy" ? q.amountOut : q.amountIn, 6)} WETH · tx ${rc!.hash}${net === "mainnet" ? `\n   https://basescan.org/tx/${rc!.hash}` : ""}`);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
