/* Take everything back: retire both Aqua strategies, remove all Iceberg v4 liquidity (the hook pulls parked reserves
 * out of Morpho itself), redeem every Morpho vault share, and unwrap WETH to ETH. Leaves ETH + USDC in the wallet.
 * NETWORK=dryrun-base|mainnet DEPLOYER_PK=... npx tsx scripts/withdraw.ts */
import { ethers } from "ethers";
import { ABI, fmt } from "../lib/iceberg";
import { icebergFor, wallet, withMakerLock } from "../lib/server";

(async () => {
  const net = process.env.NETWORK || "local";
  const b = icebergFor(net), d = b.dep;
  const pk = process.env.DEPLOYER_PK || d.keys?.maker; if (!pk) throw new Error("set DEPLOYER_PK");
  const signer = wallet(pk, b), me = await signer.getAddress();
  const step = async (what: string, p: Promise<any>) => { const rc = await (await p).wait(); console.log(`  ${what} · tx ${rc.hash}`); };
  await withMakerLock(async () => {
    const aqua = new ethers.Contract(d.aqua, ABI.aqua, signer);
    for (const [app, hash, name] of [[d.router, d.orderHash, "Iceberg Aqua position"], [d.officialRouter, d.sharedOrderHash, "official-router shared strategy"]] as const) {
      if (!app || !hash || hash === ethers.ZeroHash) continue;
      const [, cnt] = await b.aqua.rawBalances(d.maker, app, hash, d.weth);
      if (Number(cnt) === 255) { console.log(`  ${name} already retired`); continue; }
      await step(`retired the ${name}`, aqua.dock(app, hash, [d.weth, d.usdc]));
    }
    const hook = new ethers.Contract(d.hook, ABI.hookLp, signer);
    const lp: bigint = await hook.balanceOf(me);
    if (lp > 0n) await step(`removed all Iceberg v4 liquidity (${lp} ICE-LP; parked reserves pulled out of Morpho by the hook)`, hook.removeLiquidity([lp, 0, 0, Math.floor(Date.now() / 1000) + 600, 0, 0, ethers.ZeroHash]));
    for (const [v, name] of [[d.vaultWeth, "Moonwell ETH"], [d.vaultUsdc, "Steakhouse USDC"]] as const) {
      const vault = new ethers.Contract(v, ABI.vault, signer), sh: bigint = await vault.balanceOf(me);
      if (sh > 0n) await step(`redeemed all ${name} vault shares`, vault.redeem(sh, me, me));
    }
    const weth = new ethers.Contract(d.weth, ABI.weth9, signer), w: bigint = await weth.balanceOf(me);
    if (w > 0n) await step(`unwrapped ${fmt(Number(w) / 1e18, 6)} WETH to ETH`, weth.withdraw(w));
  });
  const eth = await b.provider.getBalance(me), usdc: bigint = await b.usdc.balanceOf(me);
  console.log(`wallet now: ${ethers.formatEther(eth)} ETH + ${fmt(Number(usdc) / 1e6, 6)} USDC`);
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
