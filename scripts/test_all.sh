#!/usr/bin/env bash
# Everything, one command: build, every Solidity test (unit, fuzz, 1inch invariants, Base fork, v4 hook, replay smoke),
# a fresh local stack, the end-to-end check against it, and the terminal demo. Leaves the stack running.
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; source .env; set +a; }
export BASE_RPC_URL=${BASE_RPC_URL:-${BASE_RPC:-https://mainnet.base.org}}
ok=0; fail() { echo "  [FAIL] $1"; ok=1; }
echo "== build"; forge build >/dev/null 2>&1 && echo "  [PASS] forge build" || fail "forge build"
echo "== solidity tests"
OUT=$(forge test 2>&1); echo "$OUT" | grep -E "Suite result|Ran [0-9]+ test suites" | sed 's/^/  /'
echo "$OUT" | grep -q "0 failed" && ! echo "$OUT" | grep -qE "[1-9][0-9]* failed" && echo "  [PASS] all Solidity tests" || fail "Solidity tests"
echo "== local stack (fresh)"
./scripts/start_local.sh > .run/start.out 2>&1 &
for _ in $(seq 1 240); do grep -q READY .run/start.out 2>/dev/null && break; sleep 2; done
grep -q READY .run/start.out && echo "  [PASS] stack up" || { fail "stack did not start"; tail -20 .run/start.out; exit 1; }
echo "   waiting for the keeper's first fee-aware decision…"
for _ in $(seq 1 60); do node -e 'const s=require("./deployments/local.state.json");process.exit(s.events&&s.events.at(-1).policy?0:1)' 2>/dev/null && break; sleep 3; done
echo "== end-to-end"; (cd frontend && npx tsx scripts/e2e-check.ts) || ok=1
echo "== terminal demo"; (cd frontend && npx tsx scripts/demo.ts) > .run/demo.out 2>&1 && grep -q "Done." .run/demo.out && echo "  [PASS] terminal demo ran all 10 steps (.run/demo.out)" || { fail "terminal demo"; tail -5 .run/demo.out; }
[ $ok -eq 0 ] && echo "ALL CHECKS PASSED." || echo "SOME CHECKS FAILED (see above)."
exit $ok
