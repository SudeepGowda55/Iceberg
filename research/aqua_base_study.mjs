// Aqua on Base, measured: every strategy ever shipped to the official 1inch Aqua registry, whether it was ever filled,
// and for the ones still live, whether real money backs them. Reads only public Base RPCs (no API keys).
//   node research/aqua_base_study.mjs          -> research/aqua_base_study.json
import fs from "fs";
import { ethers } from "../frontend/node_modules/ethers/lib.esm/index.js";

const AQUA = "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a", co = ethers.AbiCoder.defaultAbiCoder();
const SHIP = ethers.id("Shipped(address,address,bytes32,bytes)"), PULL = ethers.id("Pulled(address,address,bytes32,address,uint256)"), DOCK = ethers.id("Docked(address,address,bytes32)");
const P = [new ethers.JsonRpcProvider("https://base.drpc.org", 8453, { staticNetwork: true, batchMaxCount: 1 }), new ethers.JsonRpcProvider("https://mainnet.base.org", 8453, { staticNetwork: true, batchMaxCount: 1 })];
const reader = new ethers.JsonRpcProvider("https://base-rpc.publicnode.com", 8453, { staticNetwork: true });
const FROM = 32_900_000; // before Aqua's first Base strategy (Jul 2026); earlier blocks hold no Aqua events
async function logs(a, b) {
  for (let i = 0; i < 8; i++) {
    try {
      if (i % 2 === 0) return await P[0].getLogs({ address: AQUA, topics: [[SHIP, PULL, DOCK]], fromBlock: a, toBlock: b });
      const out = []; for (let x = a; x <= b; x += 2000) out.push(...await P[1].getLogs({ address: AQUA, topics: [[SHIP, PULL, DOCK]], fromBlock: x, toBlock: Math.min(x + 1999, b) })); return out;
    } catch { await new Promise(s => setTimeout(s, 800 * (i + 1))); }
  }
  throw new Error("range failed " + a);
}
const to = await P[1].getBlockNumber();
const first = Number(process.env.FROM_BLOCK || 48_000_000);
const ranges = []; for (let b = Math.max(first, FROM); b <= to; b += 10000) ranges.push([b, Math.min(b + 9999, to)]);
const ships = [], fills = new Map(), docked = new Set(); let done = 0;
const queue = [...ranges];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) { const r = queue.shift(); for (const l of await logs(...r)) {
  if (l.topics[0] === SHIP) { const [maker, app, hash] = co.decode(["address", "address", "bytes32", "bytes"], l.data); ships.push({ maker, app: app.toLowerCase(), hash, block: l.blockNumber }); }
  else if (l.topics[0] === PULL) { const h = co.decode(["address", "address", "bytes32", "address", "uint256"], l.data)[2]; fills.set(h, (fills.get(h) || 0) + 1); }
  else docked.add(co.decode(["address", "address", "bytes32"], l.data)[2]);
} if (++done % 40 === 0) console.log(`  ...${done}/${ranges.length} block ranges`); } }));
// A strategy's creation emits Pushed, not Pulled; only Pulled (maker -> taker) is a real fill.
const makers = new Set(ships.map(s => s.maker)), never = ships.filter(s => !fills.has(s.hash)), live = never.filter(s => !docked.has(s.hash));
const T = { WETH: ["0x4200000000000000000000000000000000000006", 18], USDC: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6], cbBTC: ["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8], USDT: ["0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6], DAI: ["0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18], USDbC: ["0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6] };
const aqua = new ethers.Contract(AQUA, ["function rawBalances(address,address,bytes32,address) view returns (uint248,uint8)"], reader);
const erc = t => new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], reader);
let unbacked = 0, backed = 0, other = 0;
for (const s of live) {
  let committed = 0n, deliverable = 0n, any = false;
  for (const [t] of Object.values(T)) {
    try { const [bal, cnt] = await aqua.rawBalances(s.maker, s.app, s.hash, t); if (cnt === 0n || bal === 0n) continue; any = true;
      const [w, a] = await Promise.all([erc(t).balanceOf(s.maker), erc(t).allowance(s.maker, AQUA)]); committed += 1n; if ((w < a ? w : a) > 0n) deliverable += 1n; } catch {}
  }
  if (!any) other++; else if (deliverable === 0n) unbacked++; else backed++;
}
const out = { measuredAt: new Date().toISOString(), blocks: [ranges[0][0], to], strategies: ships.length, makers: makers.size,
  neverFilled: never.length, neverFilledPct: +(100 * never.length / Math.max(1, ships.length)).toFixed(1),
  makersNeverFilled: [...makers].filter(m => !ships.some(s => s.maker === m && fills.has(s.hash))).length,
  officialRouterStrategies: ships.filter(s => s.app === "0x111111338c5091e8440b67b168bae16a668ac0de").length,
  liveButNeverFilled: live.length, liveUnbacked: unbacked, liveBackedButIdle: backed, liveOtherTokens: other };
fs.writeFileSync(new URL("./aqua_base_study.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(out);
