// Shared chain access for Iceberg (used by the keeper, the API routes, the terminal demo and the checks).
import { ethers } from "ethers";

export const WAD = 10n ** 18n;
const SPLIT_SLOT = "0xfabd6331e5dc79e94909edfa47f08fc600c5100d62072d0dc6767da2435c9700"; // PAActiveReserves ERC-7201

export const ABI = {
  aqua: ["function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)",
    "function dock(address app, bytes32 strategyHash, address[] tokens)", "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
    "event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)", "event Docked(address maker, address app, bytes32 strategyHash)",
    "event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount)",
    "event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount)"],
  router: ["function quote(tuple(address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
    "function swap(tuple(address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
    "function hash(tuple(address maker, uint256 traits, bytes data) order) view returns (bytes32)",
    "event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
    "event PASplit(bytes32 indexed orderHash, address indexed token, uint256 blockNumber, uint256 lambdaWad, uint256 passive)"],
  router102: ["function quote(tuple(address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
    "function swap(tuple(address maker, uint256 traits, bytes data) order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)",
    "event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)"],
  lens: ["function order(address maker, address hooks, address params, address feed, uint64 salt) pure returns (tuple(address maker, uint256 traits, bytes data))",
    "function sharedOrder(address maker, address officialHooks) pure returns (tuple(address maker, uint256 traits, bytes data))",
    "function takerData(address taker, bool sellWeth) pure returns (bytes)"],
  params: ["function get(address maker, bytes32 positionId) view returns (uint64 lambdaWad, int64 driftWad, bool set)",
    "function config(address maker) view returns (address keeper, uint64 minWad, uint64 maxWad)",
    "function setLambda(address maker, bytes32 positionId, uint64 lambdaWad, int64 driftWad)",
    "event LambdaSet(address indexed maker, bytes32 indexed positionId, uint64 lambdaWad, int64 driftWad, address indexed by)"],
  hook: ["function reserves() view returns (uint256 r0, uint256 r1)", "function claims() view returns (uint256 c0, uint256 c1)",
    "function activeReserves() view returns (uint256 a0, uint256 a1, uint256 lambdaWad)",
    "function parkedShares0() view returns (uint256)", "function parkedShares1() view returns (uint256)",
    "function splitBlock() view returns (uint64)", "function lastLambdaWad() view returns (uint256)", "function maxLambdaWad() view returns (uint64)",
    "function totalSupply() view returns (uint256)", "function feePips() view returns (uint24)",
    "function park(uint8 side, uint256 assets)", "function unpark(uint8 side, uint256 assets)",
    "event Split(uint256 indexed blockNumber, uint256 lambdaWad, uint256 passive0, uint256 passive1)",
    "event Parked(uint8 indexed side, uint256 assets, uint256 shares)", "event Unparked(uint8 indexed side, uint256 assets, uint256 shares)",
    "event HookSwap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint128 hookLPfeeAmount0, uint128 hookLPfeeAmount1)"],
  vaultHooks: ["event Unvaulted(address indexed maker, address indexed vault, address token, uint256 assets, bytes32 orderHash)",
    "event Vaulted(address indexed maker, address indexed vault, address token, uint256 assets, bytes32 orderHash)"],
  swapper: ["function swap(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, tuple(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, tuple(bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256)"],
  erc20: ["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"],
  vault: ["function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)",
    "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)", "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)"],
  hookLp: ["function balanceOf(address) view returns (uint256)",
    "function removeLiquidity(tuple(uint256 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline, int24 tickLower, int24 tickUpper, bytes32 userInputSalt) params) returns (int256)"],
  weth9: ["function withdraw(uint256)", "function balanceOf(address) view returns (uint256)"],
  erc20rw: ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"],
  v3router: ["function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)"],
  feed: ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function push(int256)"],
};

/** v1.0.2 taker traits for an EOA paying with transferFrom (1inch official router on Base) */
export const EOA_TRAITS_102 = "0x00000000000000000000000000000000000000000041";
export const MIN_SQRT = 4295128740n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
export const fmt = (x: number, d = 2) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

/** Same kernel as IcebergMath.split / xycOut: active = floor(total·λ); constant product with a ceil fee on the input */
export const splitActive = (total: bigint, lambdaWad: bigint) => (total * (lambdaWad > WAD ? WAD : lambdaWad)) / WAD;
export function xycOut(activeIn: bigint, activeOut: bigint, amountIn: bigint, feePips: bigint) {
  const fee = (amountIn * feePips + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * activeOut) / (activeIn + net);
}

export type Venue = "v4" | "aqua" | "official";

export class Iceberg {
  dep: any; provider: ethers.JsonRpcProvider;
  aqua: ethers.Contract; router: ethers.Contract; lens: ethers.Contract; params: ethers.Contract; hook: ethers.Contract;
  vaultHooks: ethers.Contract; feed: ethers.Contract; swapper: ethers.Contract; weth: ethers.Contract; usdc: ethers.Contract;
  vaultW: ethers.Contract; vaultU: ethers.Contract; official: ethers.Contract | null;
  private orderCache: any[] | null = null;
  private sharedCache: any[] | null = null;
  private txFrom = new Map<string, string>();

  constructor(dep: any) {
    this.dep = dep;
    this.provider = new ethers.JsonRpcProvider(dep.rpc, dep.chainId || 8453, { staticNetwork: true });
    // Base's priority tips are ~0.001 gwei; nodes (and anvil forks) often suggest 1 gwei, which makes a small wallet
    // look unable to afford a transaction. Cap the tip at 0.001 gwei and the fee at 2x base fee + tip.
    const getFeeData = this.provider.getFeeData.bind(this.provider);
    this.provider.getFeeData = async () => {
      const f = await getFeeData(), blk = await this.provider.getBlock("latest");
      const tip = 1_000_000n, base = blk?.baseFeePerGas ?? f.gasPrice ?? 0n;
      return new ethers.FeeData(f.gasPrice, base * 2n + tip, tip);
    };
    const c = (a: string, abi: string[]) => new ethers.Contract(a, abi, this.provider);
    this.aqua = c(dep.aqua, ABI.aqua); this.router = c(dep.router, ABI.router); this.lens = c(dep.lens, ABI.lens);
    this.params = c(dep.params, ABI.params); this.hook = c(dep.hook, ABI.hook); this.vaultHooks = c(dep.hooks, ABI.vaultHooks);
    this.feed = c(dep.feed, ABI.feed); this.swapper = c(dep.swapper, ABI.swapper);
    this.weth = c(dep.weth, ABI.erc20); this.usdc = c(dep.usdc, ABI.erc20);
    this.vaultW = c(dep.vaultWeth, ABI.vault); this.vaultU = c(dep.vaultUsdc, ABI.vault);
    this.official = dep.officialRouter && dep.sharedOrderHash && dep.sharedOrderHash !== ethers.ZeroHash ? c(dep.officialRouter, ABI.router102) : null;
  }

  poolKey() { return [this.dep.weth, this.dep.usdc, 0, 60, this.dep.hook]; }

  async order() {
    if (!this.orderCache) { const o = await this.lens.order(this.dep.maker, this.dep.hooks, this.dep.params, this.dep.feed, this.dep.salt ?? 1); this.orderCache = [o[0], o[1], o[2]]; }
    return this.orderCache;
  }

  async sharedOrder() {
    if (!this.sharedCache) { const o = await this.lens.sharedOrder(this.dep.maker, this.dep.officialHooks); this.sharedCache = [o[0], o[1], o[2]]; }
    return this.sharedCache;
  }

  /** The plain strategy on 1inch's official router, backed by the same Morpho vault shares (Aqua shared liquidity) */
  async sharedState() {
    if (!this.official) return null;
    const d = this.dep;
    const [[w], [u]] = await Promise.all([this.aqua.rawBalances(d.maker, d.officialRouter, d.sharedOrderHash, d.weth), this.aqua.rawBalances(d.maker, d.officialRouter, d.sharedOrderHash, d.usdc)]);
    return { weth: w as bigint, usdc: u as bigint };
  }

  async market() {
    const [blk, r] = await Promise.all([this.provider.getBlock("latest"), this.feed.latestRoundData()]);
    return { block: blk!.number, timestamp: blk!.timestamp, ethUsd: Number(r[1]) / 1e8, ageSeconds: blk!.timestamp - Number(r[3]) };
  }

  /** Stored per-block split of the Aqua position for one token: (blockNumber, passive) */
  async storedSplit(token: string) {
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [this.dep.orderHash, SPLIT_SLOT]));
    const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [token, inner]));
    const packed = BigInt(await this.provider.getStorage(this.dep.router, slot));
    return { block: Number(packed >> 192n), passive: packed & ((1n << 192n) - 1n) };
  }

  async aquaState(block: number) {
    const d = this.dep;
    const [[tW], [tU], p, sW, sU, shW, shU] = await Promise.all([
      this.aqua.rawBalances(d.maker, d.router, d.orderHash, d.weth), this.aqua.rawBalances(d.maker, d.router, d.orderHash, d.usdc),
      this.params.get(d.maker, d.orderHash), this.storedSplit(d.weth), this.storedSplit(d.usdc),
      this.vaultW.balanceOf(d.maker), this.vaultU.balanceOf(d.maker)]);
    const lambdaWad: bigint = p[2] ? BigInt(p[0]) : 500000000000000000n;
    const fresh = sW.block !== block + 1; // the next block's first fill will re-split
    const aW = fresh ? splitActive(tW, lambdaWad) : tW - sW.passive;
    const aU = fresh ? splitActive(tU, lambdaWad) : tU - sU.passive;
    const [vW, vU] = await Promise.all([this.vaultW.convertToAssets(shW), this.vaultU.convertToAssets(shU)]);
    return { totalWeth: tW as bigint, totalUsdc: tU as bigint, activeWeth: aW, activeUsdc: aU, lambdaWad, lastSplitBlock: sW.block, inVaultWeth: vW as bigint, inVaultUsdc: vU as bigint };
  }

  async hookState() {
    const [[r0, r1], [c0, c1], [a0, a1, l], ps0, ps1, sb, maxL, supply] = await Promise.all([
      this.hook.reserves(), this.hook.claims(), this.hook.activeReserves(), this.hook.parkedShares0(), this.hook.parkedShares1(),
      this.hook.splitBlock(), this.hook.maxLambdaWad(), this.hook.totalSupply()]);
    const [pW, pU] = await Promise.all([this.vaultW.convertToAssets(ps0), this.vaultU.convertToAssets(ps1)]);
    return { totalWeth: r0 as bigint, totalUsdc: r1 as bigint, inPoolWeth: c0 as bigint, inPoolUsdc: c1 as bigint, activeWeth: a0 as bigint, activeUsdc: a1 as bigint,
      lambdaWad: l as bigint, parkedWeth: pW as bigint, parkedUsdc: pU as bigint, lastSplitBlock: Number(sb), maxLambdaWad: BigInt(maxL), lpShares: supply as bigint };
  }

  /** Quote a buy (USDC in) or sell (WETH in) on either venue, exact-in, for the next block */
  async quote(venue: Venue, side: "buy" | "sell", amountIn: bigint, taker?: string) {
    if (venue === "v4") {
      const [a0, a1] = await this.hook.activeReserves();
      const fee = BigInt(this.dep.hookFeePips);
      return side === "buy" ? xycOut(a1, a0, amountIn, fee) : xycOut(a0, a1, amountIn, fee);
    }
    const [tin, tout] = side === "buy" ? [this.dep.usdc, this.dep.weth] : [this.dep.weth, this.dep.usdc];
    if (venue === "official") {
      const r = await this.official!.quote.staticCall(await this.sharedOrder(), tin, tout, amountIn, EOA_TRAITS_102, { from: taker || this.dep.maker });
      return BigInt(r[1]);
    }
    const td = await this.lens.takerData(taker || this.dep.maker, side === "sell");
    const r = await this.router.quote.staticCall(await this.order(), amountIn, td, { from: taker || this.dep.maker });
    return BigInt(r[1]);
  }

  async swapTx(signer: ethers.Signer, venue: Venue, side: "buy" | "sell", amountIn: bigint) {
    if (venue === "v4") {
      const sw = new ethers.Contract(this.dep.swapper, ABI.swapper, signer);
      return sw.swap(this.poolKey(), [side === "sell", -amountIn, side === "sell" ? MIN_SQRT : MAX_SQRT], [false, false], "0x");
    }
    if (venue === "official") {
      const r = new ethers.Contract(this.dep.officialRouter, ABI.router102, signer);
      const [tin, tout] = side === "buy" ? [this.dep.usdc, this.dep.weth] : [this.dep.weth, this.dep.usdc];
      return r.swap(await this.sharedOrder(), tin, tout, amountIn, EOA_TRAITS_102);
    }
    const r = new ethers.Contract(this.dep.router, ABI.router, signer);
    const td = await this.lens.takerData(await signer.getAddress(), side === "sell");
    return r.swap(await this.order(), amountIn, td);
  }

  /** Recent on-chain activity for the UI: swaps, splits, parking, vault moves, λ updates */
  async activity(fromBlock: number, labels: Record<string, string>) {
    const to = await this.provider.getBlockNumber();
    const from = Math.max(fromBlock, to - 4000);
    // hosted Base RPCs (Alchemy free tier, mainnet.base.org) refuse wide eth_getLogs ranges: read logs from a node that allows them
    const local = /127\.0\.0\.1|localhost/.test(this.dep.rpc || "");
    const lp = local ? this.provider : new ethers.JsonRpcProvider(process.env.LOGS_RPC || "https://base-rpc.publicnode.com", Number(this.dep.chainId || 8453), { staticNetwork: true });
    const q = (c: ethers.Contract, name: string) => (c.connect(lp) as ethers.Contract).queryFilter(c.filters[name](), from, to).catch(() => [] as any[]);
    const [hs, sp, pk, up, aq, ps, uv, vv, ls, of, sh, dk] = await Promise.all([q(this.hook, "HookSwap"), q(this.hook, "Split"), q(this.hook, "Parked"), q(this.hook, "Unparked"),
      q(this.router, "Swapped"), q(this.router, "PASplit"), q(this.vaultHooks, "Unvaulted"), q(this.vaultHooks, "Vaulted"), q(this.params, "LambdaSet"),
      this.official ? q(this.official, "Swapped") : Promise.resolve([]), q(this.aqua, "Shipped"), q(this.aqua, "Docked")]);
    if (this.dep.officialHooks) { const oh = new ethers.Contract(this.dep.officialHooks, ABI.vaultHooks, this.provider); (uv as any[]).push(...await q(oh, "Unvaulted")); (vv as any[]).push(...await q(oh, "Vaulted")); }
    // resolve every transaction's sender in parallel (cached across calls), then label
    const hashes = [...new Set([hs, sp, pk, up, aq, ps, uv, vv, ls, of, sh, dk].flat().map((e: any) => e.transactionHash as string))].filter(h => !this.txFrom.has(h));
    await Promise.all(hashes.map(async h => { const t = await this.provider.getTransaction(h); this.txFrom.set(h, t ? t.from.toLowerCase() : ""); }));
    const who = async (h: string) => labels[this.txFrom.get(h) || ""] || "other";
    const items: any[] = [];
    const push = async (e: any, kind: string, text: string) => items.push({ kind, text, block: e.blockNumber, tx: e.transactionHash, key: e.transactionHash + e.index, source: await who(e.transactionHash) });
    // OpenZeppelin's HookSwap reports both amounts as positive; the LP fee is charged in the input token, so it gives the direction
    for (const e of hs as any[]) { const a0 = Math.abs(Number(e.args[2])) / 1e18, a1 = Math.abs(Number(e.args[3])) / 1e6, wethIn = BigInt(e.args[4]) > 0n; await push(e, "v4swap", wethIn ? `Uniswap v4: sold ${fmt(a0, 5)} WETH for ${fmt(a1)} USDC` : `Uniswap v4: bought ${fmt(a0, 5)} WETH for ${fmt(a1)} USDC`); }
    const mine = (m: string) => m.toLowerCase() === this.dep.maker.toLowerCase();
    for (const e of aq as any[]) if (mine(e.args[1])) { const buy = e.args[3].toLowerCase() === this.dep.usdc.toLowerCase(); await push(e, "aquaswap", buy ? `1inch Aqua: bought ${fmt(Number(e.args[6]) / 1e18, 5)} WETH for ${fmt(Number(e.args[5]) / 1e6)} USDC` : `1inch Aqua: sold ${fmt(Number(e.args[5]) / 1e18, 5)} WETH for ${fmt(Number(e.args[6]) / 1e6)} USDC`); }
    for (const e of sp as any[]) await push(e, "split", `v4 split: λ ${fmt(Number(e.args[1]) / 1e16, 0)}%, passive ${fmt(Number(e.args[2]) / 1e18, 4)} WETH + ${fmt(Number(e.args[3]) / 1e6)} USDC frozen for block ${e.args[0]}`);
    for (const e of of as any[]) if (e.args[0] === this.dep.sharedOrderHash) { const buy = e.args[3].toLowerCase() === this.dep.usdc.toLowerCase(); await push(e, "sharedswap", buy ? `1inch official router (shared liquidity): bought ${fmt(Number(e.args[6]) / 1e18, 5)} WETH for ${fmt(Number(e.args[5]) / 1e6)} USDC` : `1inch official router (shared liquidity): sold ${fmt(Number(e.args[5]) / 1e18, 5)} WETH for ${fmt(Number(e.args[6]) / 1e6)} USDC`); }
    for (const e of dk as any[]) if (mine(e.args[0]) && e.args[1].toLowerCase() === this.dep.router.toLowerCase()) await push(e, "rebalance", `rebalance: retired Aqua strategy ${e.args[2].slice(0, 10)}…`);
    for (const e of sh as any[]) if (mine(e.args[0]) && e.args[1].toLowerCase() === this.dep.router.toLowerCase()) await push(e, "rebalance", `shipped Aqua strategy ${e.args[2].slice(0, 10)}… (balanced at the live price)`);
    for (const e of ps as any[]) if (e.args[1].toLowerCase() === this.dep.weth.toLowerCase()) await push(e, "split", `Aqua split: λ ${fmt(Number(e.args[3]) / 1e16, 0)}%, passive ${fmt(Number(e.args[4]) / 1e18, 4)} WETH frozen for block ${e.args[2]}`);
    for (const e of pk as any[]) await push(e, "park", `parked ${fmt(Number(e.args[1]) / (e.args[0] == 0n ? 1e18 : 1e6), 4)} ${e.args[0] == 0n ? "WETH" : "USDC"} of idle v4 reserves in Morpho`);
    for (const e of up as any[]) await push(e, "park", `unparked ${fmt(Number(e.args[1]) / (e.args[0] == 0n ? 1e18 : 1e6), 4)} ${e.args[0] == 0n ? "WETH" : "USDC"} from Morpho back into the pool`);
    for (const e of uv as any[]) await push(e, "vault", `Aqua fill withdrew ${fmt(Number(e.args[3]) / (e.args[2].toLowerCase() === this.dep.weth.toLowerCase() ? 1e18 : 1e6), 5)} ${e.args[2].toLowerCase() === this.dep.weth.toLowerCase() ? "WETH" : "USDC"} from its Morpho vault`);
    for (const e of vv as any[]) await push(e, "vault", `Aqua proceeds ${fmt(Number(e.args[3]) / (e.args[2].toLowerCase() === this.dep.weth.toLowerCase() ? 1e18 : 1e6), 5)} ${e.args[2].toLowerCase() === this.dep.weth.toLowerCase() ? "WETH" : "USDC"} deposited back into Morpho`);
    for (const e of ls as any[]) await push(e, "lambda", `keeper set λ = ${fmt(Number(e.args[2]) / 1e16, 0)}% for the ${e.args[1] === this.dep.poolId ? "Uniswap v4 pool" : "1inch Aqua position"}`);
    items.sort((a, b) => b.block - a.block);
    return { items: items.slice(0, 80), counts: { v4Swaps: hs.length, aquaSwaps: (aq as any[]).filter(e => mine(e.args[1])).length,
      sharedSwaps: (of as any[]).filter(e => e.args[0] === this.dep.sharedOrderHash).length, rebalances: (dk as any[]).filter(e => mine(e.args[0])).length, splits: sp.length + (ps as any[]).length / 2, parks: pk.length + up.length, vaultMoves: uv.length + vv.length, lambdaUpdates: ls.length } };
  }
}
