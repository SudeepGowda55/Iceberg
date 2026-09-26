#!/usr/bin/env bash
# Iceberg on REAL Base mainnet with your wallet: the exact flow scripts/rehearse_mainnet.sh proves on a fork.
# Spends real gas (~$0.5 at 0.006 gwei) and moves ~$32 of your funds into Morpho vaults and the Iceberg v4 pool (all stays yours).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "${CONFIRM:-}" = "yes" ] || { echo "Refusing: this sends real transactions on Base mainnet. Rehearse first (./scripts/rehearse_mainnet.sh), then re-run with CONFIRM=yes."; exit 1; }
mkdir -p deployments
ENV_FILE=${ICEBERG_ENV:-$([ -f .env ] && echo .env || echo ../walletindex/.env)}
set -a; source "$ENV_FILE"; set +a
: "${DEPLOYER_PK:?add DEPLOYER_PK to .env}"
export PK=$DEPLOYER_PK NET=mainnet FEED=0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 R=${BASE_RPC:-https://mainnet.base.org}
[ "$(cast chain-id --rpc-url "$R")" = "8453" ] || { echo "ABORT: $R is not Base mainnet"; exit 1; }
echo "Base mainnet | wallet $(cast wallet address "$PK") | $(cast from-wei "$(cast balance "$(cast wallet address "$PK")" --rpc-url "$R")") ETH | gas $(cast gas-price --rpc-url "$R") wei"
source scripts/mainnet_flow.sh
echo "Run the keeper against mainnet: (cd frontend && NETWORK=mainnet DEPLOYER_PK=... npx tsx scripts/keeper.ts)"
