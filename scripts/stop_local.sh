#!/usr/bin/env bash
# Stops the local fork, keeper and UI started by scripts/start_local.sh
cd "$(dirname "$0")/.."
for p in keeper ui anvil; do
  f=.run/$p.pid; [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"
done
pkill -f "scripts/keeper.ts" 2>/dev/null
pkill -f "next start -p ${UI_PORT:-8788}" 2>/dev/null
pkill -f "anvil --fork-url .* --port ${FORK_PORT:-8555}" 2>/dev/null
true
