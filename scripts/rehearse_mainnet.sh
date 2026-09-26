#!/usr/bin/env bash
# Iceberg mainnet dress rehearsal on a LOCAL Base fork with YOUR real wallet and balances (no free money, no impersonation):
# runs scripts/mainnet_flow.sh against 127.0.0.1 at the real Base gas price and reports what it would really cost.
# Aborts unless the endpoint answers anvil-only RPC methods, so nothing can reach mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd); RUN=$ROOT/.run; mkdir -p "$RUN" deployments
ENV_FILE=${ICEBERG_ENV:-$([ -f .env ] && echo .env || echo ../walletindex/.env)}
set -a; source "$ENV_FILE"; set +a
: "${DEPLOYER_PK:?add DEPLOYER_PK to .env}"
export PK=$DEPLOYER_PK NET=dryrun-base FEED=0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70
UPSTREAM=${BASE_RPC:-https://mainnet.base.org}; PORT=${REHEARSAL_PORT:-8547}; export R=http://127.0.0.1:$PORT
ME=$(cast wallet address "$PK")
[ -f "$RUN/rehearsal.pid" ] && kill "$(cat "$RUN/rehearsal.pid")" 2>/dev/null || true
REAL_GAS=$(cast gas-price --rpc-url "$UPSTREAM")
nohup anvil --fork-url "$UPSTREAM" --port "$PORT" --block-base-fee-per-gas "$REAL_GAS" --silent > "$RUN/rehearsal-anvil.log" 2>&1 &
echo $! > "$RUN/rehearsal.pid"
for _ in $(seq 1 30); do cast block-number --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
cast rpc anvil_nodeInfo --rpc-url $R >/dev/null || { echo "ABORT: $R is not a local anvil fork"; exit 1; }
FORK_BLOCK=$(cast block-number --rpc-url $R)
ETHPX=$(cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $R | sed -n 2p | cut -d' ' -f1)
bal() { cast call "$1" "balanceOf(address)(uint256)" "$ME" --rpc-url $R | cut -d' ' -f1; }
inVault() { cast call "$1" "convertToAssets(uint256)(uint256)" "$(bal "$1")" --rpc-url $R | cut -d' ' -f1; }
worth() { local hr; hr=${1:-"0 0"}; node -e "const [e,w,u,vw,vu,hw,hu,p]=process.argv.slice(1).map(Number);console.log(((e+w+vw+hw)/1e18*p/1e8+(u+vu+hu)/1e6).toFixed(4))" \
  "$(cast balance "$ME" --rpc-url $R)" "$(bal 0x4200000000000000000000000000000000000006)" "$(bal 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)" \
  "$(inVault 0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1)" "$(inVault 0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183)" $hr "$ETHPX"; }
rm -f deployments/$NET.json
echo "fork of Base at block $FORK_BLOCK on $R | wallet $ME | real Base gas $REAL_GAS wei"
START_USD=$(worth); echo "start: wallet worth \$$START_USD"
source scripts/mainnet_flow.sh
HR=$(cast call "$HOOK" "reserves()(uint256,uint256)" --rpc-url $R | cut -d' ' -f1 | tr '\n' ' ')
END_USD=$(worth "$HR")
echo "cost report (what this exact run would cost on real Base mainnet)"
FORK_RPC=$R UPSTREAM=$UPSTREAM npx tsx scripts/rehearsal-cost.ts "$FORK_BLOCK" "$ME" "$REAL_GAS" "$START_USD" "$END_USD" "$ETHPX" | sed 's/^/   /'
echo "UI against this rehearsal: (cd frontend && WI_ROOT=.. npx next start -p 8788) then http://localhost:8788/?net=$NET · stop fork: kill \$(cat .run/rehearsal.pid)"
