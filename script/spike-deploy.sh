#!/usr/bin/env bash
# Spike (dev) deployment: LedgerlockReactive on Lasna, ProbeGate x2, fixture LockBox (Base Sepolia) + Minter (Unichain Sepolia).
# Keys come from $LEDGERLOCK_ENV (default ~/.config/reactive/testnet-deployer.env); nothing secret lives in the repo.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
BASE_PROXY=0x476F44b11F5C942c58f4c8E3d0300E5710743585     # Reactive callback proxy, Base Sepolia (84532)
UNI_PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1      # Reactive callback proxy, Unichain Sepolia (1301)
RC_FUND=${RC_FUND:-0.25ether}
GATE_FUND=${GATE_FUND:-0.0002ether}
OUT=${ADDR_FILE:-evidence/spike-addresses.txt}

forge build >/dev/null
create() { # rpc contract value args...
  local rpc=$1 c=$2 v=$3 extra=(); shift 3
  [ "$rpc" = "$LASNA_RPC" ] && extra=(--legacy --gas-price 100gwei)   # Lasna: fixed 100 gwei; EIP-1559 headroom overshoots the balance
  forge create "$c" --broadcast --rpc-url "$rpc" --private-key "$DEPLOYER_PRIVATE_KEY" --value "$v" --json "${extra[@]}" \
    ${1:+--constructor-args "$@"} | sed -n "/^{/,\$p" | jq -r .deployedTo
}
RC=$(create "$LASNA_RPC" src/LedgerlockReactive.sol:LedgerlockReactive "$RC_FUND");           echo "RC     (5318007): $RC"
GB=$(create "$BASE_SEPOLIA_RPC" src/probe/ProbeGate.sol:ProbeGate "$GATE_FUND" $BASE_PROXY $RC $DEPLOYER_ADDRESS); echo "GATE_B (84532):   $GB"
GU=$(create "$UNICHAIN_SEPOLIA_RPC" src/probe/ProbeGate.sol:ProbeGate "$GATE_FUND" $UNI_PROXY $RC $DEPLOYER_ADDRESS); echo "GATE_U (1301):    $GU"
LB=$(create "$BASE_SEPOLIA_RPC" src/fixture/LockBox.sol:LockBox 0 $GB $DEPLOYER_ADDRESS);         echo "LOCKBOX (84532):  $LB"
MN=$(create "$UNICHAIN_SEPOLIA_RPC" src/fixture/Minter.sol:Minter 0 $GU $DEPLOYER_ADDRESS);       echo "MINTER (1301):    $MN"
INIT=$(cast send "$RC" 'init(uint256,address,address,uint256,address,address)' 84532 "$LB" "$GB" 1301 "$MN" "$GU" \
  --rpc-url "$LASNA_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --legacy --gas-price 100gwei --json | jq -r '.transactionHash + " " + .status + " gas=" + .gasUsed')
echo "init: $INIT"
{
  echo "INSTANCE=spike-dev"
  echo "RC=$RC"; echo "GATE_B=$GB"; echo "GATE_U=$GU"; echo "LOCKBOX=$LB"; echo "MINTER=$MN"
  echo "RELAYER=$DEPLOYER_ADDRESS"
  echo "LASNA_FROM=$(cast block-number --rpc-url "$LASNA_RPC")"
  echo "BASE_FROM=$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC")"
  echo "UNI_FROM=$(cast block-number --rpc-url "$UNICHAIN_SEPOLIA_RPC")"
  echo "INIT_TX=${INIT%% *}"
} > "$OUT"
cat "$OUT"
