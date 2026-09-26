#!/usr/bin/env bash
# Local Iceberg stack on a persistent Base mainnet fork: both venues deployed on the real contracts (official Aqua,
# real Uniswap v4 PoolManager, real Morpho vaults), then the fee-aware keeper and the UI + API.
# Local-only conveniences, clearly labelled: anvil test keys, whale-funded balances, and a MirrorFeed that copies the
# live Base Chainlink ETH/USD answer every keeper tick (a fork's own Chainlink freezes at the fork block).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd); RUN=$ROOT/.run; mkdir -p "$RUN" deployments
UPSTREAM=${BASE_RPC:-https://mainnet.base.org}
PORT=${FORK_PORT:-8555}; UI_PORT=${UI_PORT:-8788}; R=http://127.0.0.1:$PORT
MN="test test test test test test test test test test test junk"
pk() { cast wallet private-key --mnemonic "$MN" --mnemonic-index "$1"; }
MK=$(pk 0); TK=$(pk 4); UK=$(pk 5); CK=$(pk 6)
addr() { cast wallet address "$1"; }
WETH=0x4200000000000000000000000000000000000006; USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PM=0x498581fF718922c3f8e6A244956aF099B2652b2b; LIVE_FEED=0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70

"$ROOT/scripts/stop_local.sh" >/dev/null 2>&1 || true
echo "1/6 local Base fork from $UPSTREAM on :$PORT"
nohup anvil --fork-url "$UPSTREAM" --port "$PORT" --auto-impersonate --silent > "$RUN/anvil.log" 2>&1 &
echo $! > "$RUN/anvil.pid"
for _ in $(seq 1 30); do cast block-number --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
FORK_BLOCK=$(cast block-number --rpc-url $R); echo "   fork at Base block $FORK_BLOCK"

echo "2/6 fund the maker and three taker wallets (local test keys)"
cast rpc anvil_setBalance $PM 0x56BC75E2D63100000 --rpc-url $R >/dev/null
fund() { cast send $USDC "transfer(address,uint256)" "$1" "$2" --from $PM --unlocked --rpc-url $R >/dev/null
         cast send $WETH "deposit()" --value "$3" --private-key "$4" --rpc-url $R >/dev/null; }
fund "$(addr $MK)" 20000000000 2000000000000000000 "$MK"   # maker: 20k USDC, 2 WETH (Aqua position)
for k in "$TK" "$UK" "$CK"; do fund "$(addr $k)" 50000000000 10000000000000000000 "$k"; done

echo "3/6 MirrorFeed seeded with the live Base Chainlink ETH/USD answer (local only)"
LIVE_PX=$(cast call $LIVE_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$UPSTREAM" | sed -n 2p | cut -d' ' -f1)
BC=$(node -p "require('./out/MirrorFeed.sol/MirrorFeed.json').bytecode.object")
ARGS=$(cast abi-encode 'c(address,string,int256)' "$(addr $MK)" 'ETH / USD (mirror of live Base Chainlink)' "$LIVE_PX")
FEED=$(cast send --private-key "$MK" --rpc-url $R --json --create "${BC}${ARGS:2}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).contractAddress))")
echo "   feed $FEED at \$$((LIVE_PX/100000000))"

run() { local out; out=$(PK=$MK FEED=$FEED "$@" 2>&1 || true); echo "$out" | grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" || { echo "$out" | tail -30; exit 1; }; echo "$out"; }
echo "4/6 1inch venue: IcebergRouter + vault hooks + params + lens, then the vault-backed partially active position"
OUT=$(run forge script script/Iceberg.s.sol:Deploy --rpc-url $R --broadcast --slow)
export ROUTER=$(echo "$OUT" | awk '/^  ROUTER/{print $2}') HOOKS=$(echo "$OUT" | awk '/^  HOOKS/{print $2}') PARAMS=$(echo "$OUT" | awk '/^  PARAMS/{print $2}') OFFICIAL_HOOKS=$(echo "$OUT" | awk '/^  OFFICIAL_HOOKS/{print $2}')
LENS=$(run forge script script/Iceberg.s.sol:DeployLens --rpc-url $R --broadcast --slow | awk '/^  LENS/{print $2}')
export VAULT_WETH_AMOUNT=2000000000000000000
OUT=$(run forge script script/Iceberg.s.sol:Ship --rpc-url $R --broadcast --slow)
ORDER_HASH=$(echo "$OUT" | awk '/^  ORDER_HASH/{getline; print $1}'); SHARED_ORDER_HASH=$(echo "$OUT" | awk '/SHARED_ORDER_HASH/{getline; print $1}')
echo "   router $ROUTER | order $ORDER_HASH"

echo "5/6 Uniswap v4 venue: IcebergHook (mined address, real CREATE2 deployer), pool, liquidity, idle share parked in Morpho"
cast send $WETH "deposit()" --value 2000000000000000000 --private-key "$MK" --rpc-url $R >/dev/null
OUT=$(HOOK_WETH_AMOUNT=2000000000000000000 run forge script script/Iceberg.s.sol:DeployHook --rpc-url $R --broadcast --slow)
HOOK=$(echo "$OUT" | awk '/^  HOOK /{print $2}'); POOL_ID=$(echo "$OUT" | awk '/POOL_ID/{getline; print $1}'); SWAPPER=$(echo "$OUT" | awk '/^  SWAPPER/{print $2}')
echo "   hook $HOOK | pool $POOL_ID"
# taker approvals: v4 swap router and the 1inch router (EOA takers pay with transferFrom)
for k in "$TK" "$UK" "$CK"; do for t in $WETH $USDC; do
  cast send $t "approve(address,uint256)" "$SWAPPER" "$(cast max-uint)" --private-key "$k" --rpc-url $R >/dev/null
  cast send $t "approve(address,uint256)" "$ROUTER" "$(cast max-uint)" --private-key "$k" --rpc-url $R >/dev/null
  cast send $t "approve(address,uint256)" 0x111111338c5091E8440b67B168bAe16a668AC0De "$(cast max-uint)" --private-key "$k" --rpc-url $R >/dev/null
done; done

cat > deployments/local.json <<JSON
{"network":"local","chainId":8453,"rpc":"$R","deployBlock":$((FORK_BLOCK+1)),"mirror":true,
 "aqua":"0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a","poolManager":"$PM","weth":"$WETH","usdc":"$USDC",
 "vaultWeth":"0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1","vaultUsdc":"0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
 "feed":"$FEED","liveFeed":"$LIVE_FEED","router":"$ROUTER","hooks":"$HOOKS","params":"$PARAMS","lens":"$LENS","orderHash":"$ORDER_HASH","salt":1,"officialRouter":"0x111111338c5091E8440b67B168bAe16a668AC0De","officialHooks":"$OFFICIAL_HOOKS","sharedOrderHash":"$SHARED_ORDER_HASH",
 "hook":"$HOOK","poolId":"$POOL_ID","swapper":"$SWAPPER","maker":"$(addr $MK)","aquaFeeBps":5,"hookFeePips":500,
 "keys":{"maker":"$MK","trader":"$TK","ui":"$UK","cli":"$CK"}}
JSON
rm -f deployments/local.state.json

echo "6/6 fee-aware keeper and the UI + API"
(cd frontend && NETWORK=local INTERVAL=${INTERVAL:-20} nohup node --import tsx scripts/keeper.ts >> "$RUN/keeper.log" 2>&1 & echo $! > "$RUN/keeper.pid")
(cd frontend && npx next build >/dev/null 2>&1)
(cd frontend && WI_ROOT="$ROOT" nohup npx next start -p "$UI_PORT" > "$RUN/ui.log" 2>&1 & echo $! > "$RUN/ui.pid")
for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$UI_PORT/api/status" && break; sleep 1; done
echo "READY. UI http://localhost:$UI_PORT/ | API http://localhost:$UI_PORT/api/status | fork $R | keeper log .run/keeper.log"
