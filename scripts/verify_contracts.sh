#!/usr/bin/env bash
# Checks that every external contract Iceberg builds on is source-verified on Base and prints its runtime code hash,
# and that official 1inch Aqua runs identical code on Base, Ethereum and Polygon.
set -euo pipefail
R=${BASE_RPC:-https://mainnet.base.org}
for a in "1inch Aqua 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a" "1inch AquaSwapVMRouter 0x111111338c5091E8440b67B168bAe16a668AC0De" \
         "Uniswap v4 PoolManager 0x498581fF718922c3f8e6A244956aF099B2652b2b" "Morpho Moonwell Flagship ETH 0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1" \
         "Morpho Steakhouse USDC 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183" "Chainlink ETH/USD 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70"; do
  ad=${a##* }; n=${a% *}
  v=$(curl -s "https://base.blockscout.com/api/v2/smart-contracts/$ad" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(`${r.is_verified?"source-verified":"NOT verified"} as ${r.name} (${r.compiler_version})`)}catch(e){console.log("explorer unavailable")}})')
  echo "$n $ad: $v · runtime keccak $(cast keccak "$(cast code "$ad" --rpc-url "$R")")"
  sleep 1
done
A=0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a
for c in "Base $R" "Ethereum https://ethereum-rpc.publicnode.com" "Polygon https://polygon-bor-rpc.publicnode.com"; do
  echo "Aqua on ${c%% *}: $(cast keccak "$(cast code $A --rpc-url "${c##* }")")"
done
