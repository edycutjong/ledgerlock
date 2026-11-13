#!/usr/bin/env bash
# Print the dev RC's Lasna logs (event name, Lasna tx, origin tx) — optional: wait until at least N logs exist.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
source evidence/spike-addresses.txt
want=${1:-0}
for i in $(seq 1 30); do
  n=$(cast logs --from-block "$LASNA_FROM" --address "$RC" --rpc-url "$LASNA_RPC" --json | jq length)
  [ "$n" -ge "$want" ] && break
  sleep 5
done
cast logs --from-block "$LASNA_FROM" --address "$RC" --rpc-url "$LASNA_RPC" --json \
  | jq -r '.[] | [.blockNumber, .transactionHash, .topics[0][0:10], (.topics[1] // "")[0:10], (.topics[2] // "")] | @tsv'
echo "rc_balance=$(cast balance --ether "$RC" --rpc-url "$LASNA_RPC")"
