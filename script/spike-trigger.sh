#!/usr/bin/env bash
# Spike triggers against the dev deployment. Usage:
#   spike-trigger.sh lock <to> <amount_wei>            # Base Sepolia LockBox.lock
#   spike-trigger.sh mint <nonce> <to> <amount_wei>    # Unichain Sepolia Minter.mint (relayer key = deployer)
#   spike-trigger.sh resolve <key,key,...>             # Lasna LedgerlockReactive.resolve
#   spike-trigger.sh failnext <true|false>             # both ProbeGates (guardian)
#   spike-trigger.sh hop | armcron
# Appends one row per tx to evidence/spike-actions.csv.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
source evidence/spike-addresses.txt
CSV=evidence/spike-actions.csv
[ -f "$CSV" ] || echo "action,chain_id,tx,sent_at_ms,status,args" > "$CSV"
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
send() { # chain rpc to sig args...
  local chain=$1 rpc=$2 to=$3 sig=$4; shift 4
  local extra=(); [ "$chain" = 5318007 ] && extra=(--legacy --gas-price 100gwei)
  local t0; t0=$(now_ms)
  local out; out=$(cast send "$to" "$sig" "$@" --rpc-url "$rpc" --private-key "$DEPLOYER_PRIVATE_KEY" "${extra[@]}" --json)
  local tx st; tx=$(jq -r .transactionHash <<<"$out"); st=$(jq -r .status <<<"$out")
  echo "$ACTION,$chain,$tx,$t0,$st,\"$*\"" >> "$CSV"
  echo "$ACTION $chain $tx status=$st gas=$(jq -r .gasUsed <<<"$out")"
}
ACTION=$1; shift
case "$ACTION" in
  lock)     send 84532 "$BASE_SEPOLIA_RPC" "$LOCKBOX" 'lock(address,uint256)' "$1" "$2" ;;
  mint)     send 1301 "$UNICHAIN_SEPOLIA_RPC" "$MINTER" 'mint(uint64,address,uint256)' "$1" "$2" "$3" ;;
  resolve)  send 5318007 "$LASNA_RPC" "$RC" 'resolve(uint256[])' "[$1]" ;;
  failnext) send 84532 "$BASE_SEPOLIA_RPC" "$GATE_B" 'setFailNext(bool)' "$1"
            send 1301 "$UNICHAIN_SEPOLIA_RPC" "$GATE_U" 'setFailNext(bool)' "$1" ;;
  hop)      send 5318007 "$LASNA_RPC" "$RC" 'probeHop()' ;;
  armcron)  send 5318007 "$LASNA_RPC" "$RC" 'armCronProbe()' ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
