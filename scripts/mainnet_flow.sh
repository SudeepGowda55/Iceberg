#!/usr/bin/env bash
# The Iceberg mainnet flow with ONE wallet (deployer, maker, keeper, taker). Sourced by rehearse_mainnet.sh (local fork)
# and deploy_mainnet.sh (Base mainnet), so the rehearsal proves exactly what mainnet runs.
# Expects: R (rpc), PK, NET (deployments/<NET>.json), FEED (Chainlink ETH/USD address to price against).
set -euo pipefail
ME=$(cast wallet address "$PK")
WETH=0x4200000000000000000000000000000000000006; USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; SR02=0x2626664c2603336E57B271c5C0b26F421741e481
AQUA_WETH=${AQUA_WETH:-200000000000000}    # 0.0002 WETH (~$0.55, + matching USDC) for the 1inch Aqua position, held in Morpho
HOOK_WETH=${HOOK_WETH:-200000000000000}    # 0.0002 WETH (~$0.55, + matching USDC) for the Uniswap v4 hook pool
TO_USDC=${TO_USDC:-0}                      # ETH to swap into USDC first (0 = use the USDC already in the wallet)
FILLS=${FILLS:-6}; HOOK_FILLS=${HOOK_FILLS:-4}; FILL_CENTS=${FILL_CENTS:-2}
LAMBDAS=${LAMBDAS:-500000000000000000,400000000000000000,700000000000000000,1000000000000000000}
LOG=deployments/$NET.log; : > "$LOG"
log() { echo "$*" | tee -a "$LOG"; }
send() { cast send --private-key "$PK" --rpc-url "$R" --priority-gas-price 1000000 --json "$@" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).transactionHash))"; }
run() { local out; out=$(FEED=$FEED forge script "script/Iceberg.s.sol:$1" --rpc-url "$R" --broadcast --slow 2>&1 || true)
        echo "$out" | grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" || { echo "$out" | tail -30 >&2; exit 1; }; echo "$out"; }
ETHPX=$(cast call "$FEED" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$R" | sed -n 2p | cut -d' ' -f1)

log "1/8 wrap ETH for both venues (and buy USDC only if TO_USDC > 0)"
log "   wrap tx $(send $WETH 'deposit()' --value $((AQUA_WETH + HOOK_WETH)))"
if [ "$TO_USDC" != "0" ]; then
  MIN_USDC=$(node -p "(BigInt($TO_USDC)*BigInt($ETHPX)*98n/100n/10n**20n).toString()")
  log "   buy USDC tx $(send $SR02 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))' "($WETH,$USDC,500,$ME,$TO_USDC,$MIN_USDC,0)" --value "$TO_USDC")"
else log "   using the wallet's own USDC ($(cast call $USDC 'balanceOf(address)(uint256)' $ME --rpc-url $R | cut -d' ' -f1) raw units), no swap"; fi

log "2/8 deploy IcebergRouter (official Aqua router + Iceberg opcodes), VaultedInventoryHooks, IcebergParams, IcebergLens"
OUT=$(run Deploy)
export ROUTER=$(echo "$OUT" | awk '/^  ROUTER/{print $2}') HOOKS=$(echo "$OUT" | awk '/^  HOOKS/{print $2}') PARAMS=$(echo "$OUT" | awk '/^  PARAMS/{print $2}') OFFICIAL_HOOKS=$(echo "$OUT" | awk '/^  OFFICIAL_HOOKS/{print $2}')
LENS=$(run DeployLens | awk '/^  LENS/{print $2}')
log "   router $ROUTER | vault hooks $HOOKS | params $PARAMS | lens $LENS"

log "3/8 1inch venue: vault the inventory in Morpho, approvals, keeper, ship the partially active position"
OUT=$(VAULT_WETH_AMOUNT=$AQUA_WETH run Ship); ORDER_HASH=$(echo "$OUT" | awk '/^  ORDER_HASH/{getline; print $1}'); SHARED_ORDER_HASH=$(echo "$OUT" | awk '/SHARED_ORDER_HASH/{getline; print $1}')
log "   order $ORDER_HASH"

log "4/8 Uniswap v4 venue: IcebergHook via the real CREATE2 deployer, pool, liquidity, idle share parked in Morpho"
OUT=$(HOOK_WETH_AMOUNT=$HOOK_WETH run DeployHook)
HOOK=$(echo "$OUT" | awk '/^  HOOK /{print $2}'); POOL_ID=$(echo "$OUT" | awk '/POOL_ID/{getline; print $1}'); SWAPPER=$(echo "$OUT" | awk '/^  SWAPPER/{print $2}')
log "   hook $HOOK | pool $POOL_ID | swap router $SWAPPER"
BLK=$(cast block-number --rpc-url "$R")
RPC_PUBLIC=$R; case "$R" in *alchemy*|*infura*|*quiknode*|*/v2/*|*/v3/*) RPC_PUBLIC=https://mainnet.base.org;; esac   # never write an RPC key into a committed file
rm -f deployments/$NET.state.json   # a fresh deployment starts with no keeper / rebalance state
cat > deployments/$NET.json <<JSON
{"network":"$NET","chainId":8453,"rpc":"$RPC_PUBLIC","deployBlock":$BLK,"mirror":false,
 "aqua":"0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a","poolManager":"0x498581fF718922c3f8e6A244956aF099B2652b2b","weth":"$WETH","usdc":"$USDC",
 "vaultWeth":"0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1","vaultUsdc":"0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
 "feed":"$FEED","liveFeed":"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70","router":"$ROUTER","hooks":"$HOOKS","params":"$PARAMS","lens":"$LENS","orderHash":"$ORDER_HASH","salt":1,"officialRouter":"0x111111338c5091E8440b67B168bAe16a668AC0De","officialHooks":"$OFFICIAL_HOOKS","sharedOrderHash":"$SHARED_ORDER_HASH",
 "hook":"$HOOK","poolId":"$POOL_ID","swapper":"$SWAPPER","maker":"$ME","aquaFeeBps":5,"hookFeePips":500}
JSON

log "5/8 $FILLS real fills on the 1inch Aqua position (buy $FILL_CENTS cents of WETH, sell it back), keeper λ every 5"
FILLS=$FILLS FILL_CENTS=$FILL_CENTS LAMBDAS=$LAMBDAS run Fill | grep -E "^  (BUY|SELL)" | sed 's/^/   /' | tee -a "$LOG" | tail -2
log "6/8 $HOOK_FILLS real swaps through the Uniswap v4 pool, keeper λ every 5"
PARAMS=$PARAMS HOOK=$HOOK SWAPPER=$SWAPPER POOL_ID=$POOL_ID FILLS=$HOOK_FILLS FILL_CENTS=$FILL_CENTS LAMBDAS=$LAMBDAS run FillHook | grep -E "^  V4_" | sed 's/^/   /' | tee -a "$LOG" | tail -2
log "7/8 weight-tracking rebalance of the Aqua position (retire, rebalance through Uniswap v3, re-ship balanced)"
(cd frontend && NETWORK=$NET DEPLOYER_PK=$PK FORCE=1 npx tsx scripts/rebalance.ts) | sed 's/^/   /' | tee -a "$LOG"
log "8/8 Aqua shared liquidity: two fills on 1inch's official router from the same Morpho balances"
(cd frontend && NETWORK=$NET DEPLOYER_PK=$PK npx tsx scripts/swap.ts official buy 0.02 && NETWORK=$NET DEPLOYER_PK=$PK npx tsx scripts/swap.ts official sell 0.015) | sed 's/^/   /' | tee -a "$LOG"
log "transaction hashes: broadcast/Iceberg.s.sol/8453/*/run-latest.json + $LOG"
