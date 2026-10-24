// Static content for the marketing pages. Every number here comes from the README's evidence table / deployments/mainnet.json.
export const NAV = [
  { href: "/", label: "Home" },
  { href: "/mechanism", label: "Mechanism" },
  { href: "/evidence", label: "Evidence" },
  { href: "/live", label: "Live" },
  { href: "/contracts", label: "Contracts" },
];

export const SITE = "https://iceberg-lp.vercel.app"; // production URL: link previews, sitemap, canonical
// Next.js replaces (not merges) openGraph/twitter per route, so every route layout re-lists the preview image
export const OG_IMAGE = { url: "/og.png", width: 1200, height: 627, alt: "Iceberg: a 3D iceberg whose tip above the waterline is the share of reserves arbitrage can reach" };
export const REPO = "https://github.com/SudeepGowda55/Iceberg";
export const scan = (a: string) => `https://basescan.org/${a.length > 42 ? "tx" : "address"}/${a}`;

export const AQUA_STUDY = { strategies: 872, makers: 144, neverFilledPct: 51.7, makersNeverFilled: 66, liveNeverFilled: 80, liveUnbacked: 41 };

export const CONTRACTS = [
  { name: "IcebergRouter", venue: "aqua", what: "1inch's Aqua router plus the two Iceberg SwapVM opcodes: PAActiveReserves 0x92 and ChainlinkDeviationGuard 0x21", addr: "0xE4989c27d45bcE9b44c4721daca0790e02BC84b5" },
  { name: "IcebergHook", venue: "uni", what: "Uniswap v4 hook on OpenZeppelin BaseCustomCurve: the same per-block freeze inside the pool, idle reserves parked in Morpho", addr: "0xe5a690F6F0b10e4EE33DEFa271E8C893dd3ceA88" },
  { name: "IcebergParams", venue: "keeper", what: "The keeper's λ for both venues, each inside a maker-controlled, revocable range", addr: "0x0e5ac4A76930cfa67820d63cC1962a87Ef8FC4B9" },
  { name: "VaultedInventoryHooks", venue: "morpho", what: "Pulls an Aqua fill's output from Morpho and deposits its input back, in the same transaction", addr: "0x7478da369578471D621826451Ba67453720Aa4F4" },
  { name: "VaultedInventoryHooks · official", venue: "morpho", what: "The same, for the shared-liquidity strategy on 1inch's unmodified official router", addr: "0x14D4E5e7f9E475F714c48F030Ad03e3A2C0d8409" },
  { name: "IcebergLens", venue: "aqua", what: "Read-only helper that builds orders for off-chain code", addr: "0x2bC214ea3d908C792bF5def677Cf95ECA407D630" },
  { name: "PoolSwapTest", venue: "uni", what: "Swap router used to trade the v4 pool", addr: "0xC99519426A499e388F71C1d0EFDEf6067cf475C3" },
  { name: "Wallet", venue: "keeper", what: "The one wallet that deployed everything and plays maker, keeper and taker", addr: "0x3AaAe578f1F6bBE9705363DE4354d64d6a09C8B7" },
] as const;

export const BUILT_ON = [
  { name: "Uniswap v4 PoolManager", addr: "0x498581fF718922c3f8e6A244956aF099B2652b2b" },
  { name: "1inch Aqua", addr: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a" },
  { name: "1inch official router", addr: "0x111111338c5091E8440b67B168bAe16a668AC0De" },
  { name: "Morpho · Moonwell Flagship ETH", addr: "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1" },
  { name: "Morpho · Steakhouse USDC", addr: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" },
  { name: "Chainlink ETH/USD", addr: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
];

export const MAINNET_TXS = [
  { what: "Iceberg position shipped to Aqua", tx: "0x8c3169b5ed6a5a9b3faa5f7ad50ccec0451059d2a31e4e657c72f0cadd9ebd68" },
  { what: "Aqua fill through the Iceberg SwapVM opcodes", tx: "0x0f1ba3fbcca85306f06d07824d7fd5b00a5f68abe44e1cef99f159684254cce4" },
  { what: "Uniswap v4 swap through the hook", tx: "0x42df14c2ca1b1310c7b6e6dbb363d5e9af31a9a8c6d7068e7cbbc07793e93be5" },
  { what: "Weight-tracking re-ship", tx: "0xa9010841bddf10a85b51e21a776d7146cfe2acb4fba7820b97e939b0076c0ae0" },
  { what: "Shared-liquidity fill on 1inch's official router", tx: "0xade98dedee14edb32896610acb9ab617ca1f6fec3ddb158a7866b65b5e49fc31" },
];

export const CLAIMS = [
  { title: "Real replay, 21 Sep 2026", stat: "−19.3%", body: "1,440 minutes at 5 bps on a Base fork. LP loss vs a perfectly rebalanced portfolio: plain v4 $1.077 · λ 50% $0.888 · λ 39% $0.869. The Aqua position at λ 50% lost exactly what the hook did.", cmd: "REPLAY_MINUTES=1440 BASE_RPC_URL=https://mainnet.base.org forge test --match-contract Replay21Sep -vv" },
  { title: "Fee-aware λ, 7 days", stat: "−32%", body: "On a week of real ETH/USD: −32% loss at 1 bps, −17% at 5 bps. At 30 bps the best λ is 100%, so the keeper tunes λ to each pool's fee.", cmd: "node research/lambda_policy.mjs" },
  { title: "Kernel matches the paper", stat: "1e-16", body: "λ* within 1e-16, Theorem 1 within 5e-15, ln within 8e-11 of the float reference.", cmd: "forge test --match-path test/unit/IcebergMath.t.sol -vv" },
  { title: "1inch's own invariants hold", stat: "6/6", body: "CoreInvariants (symmetry, additivity, quote == swap, monotonicity, rounding favours maker, balance sufficiency) at λ = 1, 0.5 and 0.25, with and without fee.", cmd: "forge test --match-path test/invariant/PAInvariants.t.sol" },
  { title: "Works on real Base contracts", stat: "52", body: "11 Aqua fork tests and 11 v4 hook fork tests among 52 in total, against the real PoolManager, Aqua, Morpho and Chainlink.", cmd: "BASE_RPC_URL=https://mainnet.base.org forge test" },
  { title: "Mainnet run rehearsed first", stat: "$0.20", body: "The exact mainnet flow on a fork with the real wallet: 64 transactions, then the withdraw script returned every USDC and all ETH except gas.", cmd: "./scripts/rehearse_mainnet.sh" },
];
