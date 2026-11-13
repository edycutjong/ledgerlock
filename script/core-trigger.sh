#!/usr/bin/env bash
# Triggers against a core-flow deployment ($INSTANCE, default core-dev). Usage:
#   core-trigger.sh lock <to> <amount_wei>             # Base Sepolia LockBox.lock (never gated)
#   core-trigger.sh mint <nonce> <to> <amount_wei>     # Unichain Sepolia Minter.mint (relayer key = deployer)
#   core-trigger.sh legit <to> <amount_wei>            # strict relayer: lock, wait for it to mine, mint its nonce
#   core-trigger.sh attack <nonce> <to> <amount_wei>   # stolen relayer key: a mint with no lock behind it
#   core-trigger.sh burn <to> <amount_wei> | release <burnNonce> <to> <amount_wei> | seize <holder> <amount_wei>
#   core-trigger.sh resolve <reason> <acceptDeficit>   # Lasna LedgerlockReactive.resolve(route, reason, accept)
#   core-trigger.sh failnext <true|false>              # both ProbeGates (guardian): forces CallbackFailure
#   core-trigger.sh state                              # routeState(route)
# Appends one row per tx to evidence/<instance>-actions.csv.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
INSTANCE=${INSTANCE:-core-dev}
source "evidence/$INSTANCE-addresses.txt"
CSV=evidence/$INSTANCE-actions.csv
[ -f "$CSV" ] || echo "action,chain_id,tx,sent_at_ms,status,args" > "$CSV"
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
send() { # chain rpc to sig args...
  local chain=$1 rpc=$2 to=$3 sig=$4; shift 4
  local extra=(); [ "$chain" = 5318007 ] && extra=(--legacy --gas-price 100gwei)
  local t0; t0=$(now_ms)
  local out; out=$(cast send "$to" "$sig" "$@" --rpc-url "$rpc" --private-key "$DEPLOYER_PRIVATE_KEY" "${extra[@]}" --json)
  LAST_TX=$(jq -r .transactionHash <<<"$out"); local st; st=$(jq -r .status <<<"$out")
  echo "$ACTION,$chain,$LAST_TX,$t0,$st,\"$*\"" >> "$CSV"
  echo "$ACTION $chain $LAST_TX status=$st gas=$(jq -r .gasUsed <<<"$out")"
  LAST_RECEIPT=$out
}
ACTION=$1; shift
case "$ACTION" in
  lock)     send 84532 "$BASE_SEPOLIA_RPC" "$LOCKBOX" 'lock(address,uint256)' "$1" "$2" ;;
  mint|attack) send 1301 "$UNICHAIN_SEPOLIA_RPC" "$MINTER" 'mint(uint64,address,uint256)' "$1" "$2" "$3" ;;
  legit)    ACTION=legit-lock send 84532 "$BASE_SEPOLIA_RPC" "$LOCKBOX" 'lock(address,uint256)' "$1" "$2"
            NONCE=$(cast to-dec "$(jq -r '.logs[0].topics[1]' <<<"$LAST_RECEIPT")")
            ACTION=legit-mint send 1301 "$UNICHAIN_SEPOLIA_RPC" "$MINTER" 'mint(uint64,address,uint256)' "$NONCE" "$1" "$2" ;;
  burn)     send 1301 "$UNICHAIN_SEPOLIA_RPC" "$MINTER" 'burn(address,uint256)' "$1" "$2" ;;
  release)  send 84532 "$BASE_SEPOLIA_RPC" "$LOCKBOX" 'releaseByRelayer(uint64,address,uint256)' "$1" "$2" "$3" ;;
  seize)    send 1301 "$UNICHAIN_SEPOLIA_RPC" "$MINTER" 'seize(address,uint256)' "$1" "$2" ;;
  resolve)  send 5318007 "$LASNA_RPC" "$RC" 'resolve(uint256,uint8,bool)' "$ROUTE_ID" "$1" "$2" ;;
  failnext) send 84532 "$BASE_SEPOLIA_RPC" "$GATE_B" 'setFailNext(bool)' "$1"
            send 1301 "$UNICHAIN_SEPOLIA_RPC" "$GATE_U" 'setFailNext(bool)' "$1" ;;
  state)    cast call "$RC" 'routeState(uint256)(bool,bool,bool,uint64,uint32,uint256,uint256)' "$ROUTE_ID" --rpc-url "$LASNA_RPC"
            echo "gateB open: $(cast call "$GATE_B" 'isOpen()(bool)' --rpc-url "$BASE_SEPOLIA_RPC")  gateU open: $(cast call "$GATE_U" 'isOpen()(bool)' --rpc-url "$UNICHAIN_SEPOLIA_RPC")" ;;
  *) echo "unknown action $ACTION" >&2; exit 2 ;;
esac
