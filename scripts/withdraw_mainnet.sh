#!/usr/bin/env bash
# Take every Iceberg token back to your wallet on Base mainnet: retire both Aqua strategies, remove all Iceberg v4
# liquidity (the hook pulls its parked reserves out of Morpho), redeem every Morpho vault share, unwrap WETH to ETH.
# Leaves only ETH + USDC in the wallet. Safe to run more than once: finished steps are skipped.
#   ./scripts/withdraw_mainnet.sh              (Base mainnet, deployments/mainnet.json)
#   NET=dryrun-base ./scripts/withdraw_mainnet.sh   (the fork rehearsal)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=${ICEBERG_ENV:-.env}
set -a; source "$ENV_FILE"; set +a
: "${DEPLOYER_PK:?add DEPLOYER_PK to .env}"
NET=${NET:-mainnet}
[ -f "deployments/$NET.json" ] || { echo "no deployments/$NET.json: nothing deployed on $NET"; exit 1; }
ME=$(cast wallet address "$DEPLOYER_PK")
echo "withdrawing everything on $NET back to $ME"
(cd frontend && NETWORK=$NET DEPLOYER_PK=$DEPLOYER_PK npx tsx scripts/withdraw.ts)
