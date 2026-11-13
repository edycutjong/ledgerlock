#!/usr/bin/env bash
# Liveness heartbeat on the live deployment: one real legitimate transfer through route A every 6 h (launchd StartInterval 21600).
# The first run of each UTC day is a labelled "forced fill-before-deposit" run (mint first, lock after), so a fresh pause + auto-resume
# loop appears daily. Skips (and logs) when the guard's lREACT reserve is below 2. Rows: evidence/<instance>-heartbeat-runs.csv.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$HOME/.foundry/bin:$PATH"
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
INSTANCE=${INSTANCE:-frozen}
source "evidence/$INSTANCE-addresses.txt"
RES=$(cast balance "$RC" --rpc-url "$LASNA_RPC" -e | cut -d. -f1)
if [ "${RES:-0}" -lt 2 ]; then echo "$(date -u +%FT%TZ) skip: guard reserve ${RES} lREACT < 2" >> "evidence/$INSTANCE-heartbeat.log"; exit 0; fi
IDX=$(( $(date -u +%s) / 21600 ))
KIND=legit_strict; [ "$(date -u +%H)" -lt 6 ] && KIND=legit_forced
BENCH_OUT="evidence/$INSTANCE-heartbeat-runs.csv" npx tsx scripts/bench.ts "$INSTANCE" "$KIND" 1 "$IDX" >> "evidence/$INSTANCE-heartbeat.log" 2>&1
