#!/usr/bin/env bash
# Put small positions back into the EXISTING mainnet deployment after ./scripts/withdraw_mainnet.sh (no redeploy):
# wrap ETH, Refund (new Aqua strategy with the next salt, fresh official-router hooks), then a fresh v4 hook + pool
# (DeployHook with the next HOOK_VARIANT: the old pool keeps locked minimum-liquidity dust at a skewed price).
#   CONFIRM=yes ./scripts/refund_mainnet.sh          (Base mainnet)
#   NET=<name> R=<fork rpc> ./scripts/refund_mainnet.sh   (rehearsal against a fork; deployments/<name>.json)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source "${ICEBERG_ENV:-.env}"; set +a
: "${DEPLOYER_PK:?add DEPLOYER_PK to .env}"
NET=${NET:-mainnet}; D=deployments/$NET.json; S=deployments/$NET.state.json
R=${R:-${BASE_RPC:-https://mainnet.base.org}}
[ "$NET" != "mainnet" ] || [ "${CONFIRM:-}" = "yes" ] || { echo "Refusing: real Base mainnet transactions. Re-run with CONFIRM=yes."; exit 1; }
AQUA_WETH=${AQUA_WETH:-100000000000000}; HOOK_WETH=${HOOK_WETH:-100000000000000}   # 0.0001 WETH (~$0.27) + matching USDC each
SALT=$(( $( (jq -r '.aqua.salt // empty' "$S" 2>/dev/null || true) | grep . || jq -r .salt "$D") + 1 ))
ME=$(cast wallet address "$DEPLOYER_PK")
echo "re-funding $NET for $ME: ${AQUA_WETH} wei WETH per venue, Aqua strategy salt $SALT"
cast send 0x4200000000000000000000000000000000000006 'deposit()' --value $((AQUA_WETH + HOOK_WETH)) --private-key "$DEPLOYER_PK" --rpc-url "$R" --priority-gas-price 1000000 --json | jq -r '"   wrap tx " + .transactionHash'
run() { local out; out=$(PK=$DEPLOYER_PK forge script "script/Iceberg.s.sol:$1" --rpc-url "$R" --broadcast --slow 2>&1 || true)
        echo "$out" | grep -q "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" || { echo "$out" | grep -E "Error|Revert" | tail -5 | sed -E 's#(/v2/)[A-Za-z0-9_-]+#\1<hidden>#g' >&2; exit 1; }; echo "$out"; }
OUT=$(ROUTER=$(jq -r .router $D) HOOKS=$(jq -r .hooks $D) PARAMS=$(jq -r .params $D) SALT=$SALT AQUA_WETH=$AQUA_WETH LAMBDA=${LAMBDA:-400000000000000000} run Refund)
OH=$(echo "$OUT" | awk '/^  ORDER_HASH/{getline; print $1}'); SH=$(echo "$OUT" | awk '/SHARED_ORDER_HASH/{getline; print $1}'); OFH=$(echo "$OUT" | awk '/^  OFFICIAL_HOOKS/{print $2}')
echo "   Aqua strategy $OH (salt $SALT) | shared strategy $SH via hooks $OFH"
VARIANT=$(( $(jq -r '.hookVariant // 0' "$D") + 1 ))
OUT=$(PARAMS=$(jq -r .params $D) HOOK_WETH_AMOUNT=$HOOK_WETH HOOK_VARIANT=$VARIANT run DeployHook)
HOOK=$(echo "$OUT" | awk '/^  HOOK /{print $2}'); POOL_ID=$(echo "$OUT" | awk '/POOL_ID/{getline; print $1}'); SWAPPER=$(echo "$OUT" | awk '/^  SWAPPER/{print $2}')
echo "   fresh v4 hook $HOOK | pool $POOL_ID (variant $VARIANT)"
jq --arg oh "$OH" --arg sh "$SH" --arg ofh "$OFH" --argjson salt "$SALT" --arg hook "$HOOK" --arg pool "$POOL_ID" --arg sw "$SWAPPER" --argjson v "$VARIANT" \
   '.orderHash=$oh | .sharedOrderHash=$sh | .officialHooks=$ofh | .salt=$salt | .hook=$hook | .poolId=$pool | .swapper=$sw | .hookVariant=$v' "$D" > "$D.tmp" && mv "$D.tmp" "$D"
rm -f "$S"   # the refreshed deployments file is the source of truth again
