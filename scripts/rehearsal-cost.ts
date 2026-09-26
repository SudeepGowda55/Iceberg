/* Cost report for scripts/rehearse_mainnet.sh (Iceberg): what the rehearsal would cost on real Base mainnet.
 * Sums gas actually used by every transaction the wallet sent on the fork, priced at the real Base gas price,
 * plus Base's L1 data fee (read-only call to Base's GasPriceOracle), plus what swaps/fees/slippage cost in value. */
import { ethers } from "ethers";

const [fromBlock, me, realGas, worthStart, worthEnd, ethPx8] = process.argv.slice(2);
const fork = new ethers.JsonRpcProvider(process.env.FORK_RPC || "http://127.0.0.1:8546");
const base = new ethers.JsonRpcProvider(process.env.UPSTREAM || "https://base-rpc.publicnode.com", 8453, { staticNetwork: true });
const oracle = new ethers.Contract("0x420000000000000000000000000000000000000F", ["function getL1FeeUpperBound(uint256) view returns (uint256)"], base);
const INR = Number(process.env.USD_INR || 88), px = Number(ethPx8) / 1e8;

(async () => {
  const to = await fork.getBlockNumber(), phases: Record<string, { n: number; gas: bigint; l1: bigint; forkPaid: bigint }> = {};
  for (let b = Number(fromBlock) + 1; b <= to; b++) {
    const blk = await fork.getBlock(b, true);
    for (const tx of blk!.prefetchedTransactions) {
      if (tx.from.toLowerCase() !== me.toLowerCase()) continue;
      const rc = await fork.getTransactionReceipt(tx.hash);
      const size = ethers.getBytes(tx.data).length + 120;   // calldata + envelope, what Base posts to L1
      const l1: bigint = await oracle.getL1FeeUpperBound(size);
      const phase = !tx.to ? "deploy" : tx.data.length <= 10 && tx.value > 0n ? "tokens" : "calls";
      const p = (phases[phase] ??= { n: 0, gas: 0n, l1: 0n, forkPaid: 0n });
      p.n++; p.gas += rc!.gasUsed; p.l1 += l1; p.forkPaid += rc!.gasUsed * rc!.gasPrice;
    }
  }
  const usd = (wei: bigint) => Number(wei) / 1e18 * px, rs = (u: number) => `Rs ${(u * INR).toFixed(1)}`;
  let n = 0, gas = 0n, l1 = 0n, forkPaid = 0n;
  for (const p of Object.values(phases)) { n += p.n; gas += p.gas; l1 += p.l1; forkPaid += p.forkPaid; }
  const l2 = gas * BigInt(realGas), valueLost = Number(worthStart) - Number(worthEnd) - usd(forkPaid);
  console.log(`transactions sent: ${n} | gas used: ${gas.toLocaleString()} | real Base gas price ${Number(realGas) / 1e9} gwei`);
  console.log(`L2 gas at the real price:   $${usd(l2).toFixed(3)}  (${rs(usd(l2))})`);
  console.log(`L1 data fee (upper bound):  $${usd(l1).toFixed(3)}  (${rs(usd(l1))})`);
  console.log(`swap fees + slippage + spreads paid to yourself/pools: $${Math.max(valueLost, 0).toFixed(3)}  (${rs(Math.max(valueLost, 0))})`);
  const total = usd(l2) + usd(l1) + Math.max(valueLost, 0);
  console.log(`TOTAL it would really cost on Base mainnet: $${total.toFixed(3)}  (${rs(total)})  ${total * INR <= 100 ? "-> within Rs 100" : "-> OVER Rs 100"}`);
  console.log(`still yours afterwards (tokens in your wallet): ~$${(Number(worthEnd) + usd(forkPaid) - usd(l2) - usd(l1)).toFixed(2)}`);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
