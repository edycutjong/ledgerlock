#!/usr/bin/env bash
# Probe 4: N legit lock -> mint pairs on the fixture route, the mint sent 1-3 s after the lock is mined (a strict relayer).
# Lasna arrival order per pair is then read by scripts/spike-triples.ts into evidence/skew-pairs.csv.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
source evidence/spike-addresses.txt
N=${1:-18}
for i in $(seq 1 "$N"); do
  n=$(( $(cast call "$LOCKBOX" 'nonce()(uint64)' --rpc-url "$BASE_SEPOLIA_RPC") + 1 ))
  amt=$(( (RANDOM % 400 + 1) ))000000000000000000
  bash script/spike-trigger.sh lock "$RELAYER" "$amt"
  sleep $(( RANDOM % 3 + 1 ))
  bash script/spike-trigger.sh mint "$n" "$RELAYER" "$amt"
done
