#!/usr/bin/env bash
# Core-flow deployment: LedgerlockReactive on Lasna + gates and fixture route A on Base Sepolia (lock side) and Unichain
# Sepolia (mint side), then setProxy x2 + addRoute (NONCE, W = 60 s, K = 16). Gates are ProbeGates on dev instances so a
# live forced CallbackFailure can be shown; the frozen deployment (Nov 20) uses the same script with GATE=Gate.
# Keys come from $LEDGERLOCK_ENV (default ~/.config/reactive/testnet-deployer.env); nothing secret lives in the repo.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
BASE_PROXY=0x476F44b11F5C942c58f4c8E3d0300E5710743585     # Reactive callback proxy, Base Sepolia (84532)
UNI_PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1      # Reactive callback proxy, Unichain Sepolia (1301)
INSTANCE=${INSTANCE:-core-dev}
GATE=${GATE:-src/probe/ProbeGate.sol:ProbeGate}
RC_FUND=${RC_FUND:-5ether}            # lREACT
GATE_FUND=${GATE_FUND:-0.0002ether}
W=${W:-60}; K=${K:-16}
COLLATERAL=${COLLATERAL:-100000000000000000000000}   # 100k fixture tUSD (bookkeeping) for releases
OUT=${ADDR_FILE:-evidence/$INSTANCE-addresses.txt}
LASNA=(--legacy --gas-price 100gwei)   # Lasna: fixed 100 gwei; EIP-1559 headroom overshoots the balance

forge build >/dev/null
create() { # rpc contract value args...
  local rpc=$1 c=$2 v=$3 extra=(); shift 3
  [ "$rpc" = "$LASNA_RPC" ] && extra=("${LASNA[@]}")
  forge create "$c" --broadcast --rpc-url "$rpc" --private-key "$DEPLOYER_PRIVATE_KEY" --value "$v" --json "${extra[@]}" \
    ${1:+--constructor-args "$@"} | sed -n "/^{/,\$p" | jq -r .deployedTo
}
tx() { # rpc to sig args... -> "hash status gas"
  local rpc=$1 to=$2 sig=$3 extra=(); shift 3
  [ "$rpc" = "$LASNA_RPC" ] && extra=("${LASNA[@]}")
  cast send "$to" "$sig" "$@" --rpc-url "$rpc" --private-key "$DEPLOYER_PRIVATE_KEY" "${extra[@]}" --json \
    | jq -r '.transactionHash + " " + .status + " gas=" + .gasUsed'
}
RC=$(create "$LASNA_RPC" src/LedgerlockReactive.sol:LedgerlockReactive "$RC_FUND");               echo "RC     (5318007): $RC"
GB=$(create "$BASE_SEPOLIA_RPC" "$GATE" "$GATE_FUND" $BASE_PROXY $RC $DEPLOYER_ADDRESS);          echo "GATE_B (84532):   $GB"
GU=$(create "$UNICHAIN_SEPOLIA_RPC" "$GATE" "$GATE_FUND" $UNI_PROXY $RC $DEPLOYER_ADDRESS);       echo "GATE_U (1301):    $GU"
LB=$(create "$BASE_SEPOLIA_RPC" src/fixture/LockBox.sol:LockBox 0 $GB $DEPLOYER_ADDRESS);         echo "LOCKBOX (84532):  $LB"
MN=$(create "$UNICHAIN_SEPOLIA_RPC" src/fixture/Minter.sol:Minter 0 $GU $DEPLOYER_ADDRESS);       echo "MINTER (1301):    $MN"
echo "seed:  $(tx "$BASE_SEPOLIA_RPC" "$LB" 'seedCollateral(uint256)' "$COLLATERAL")"
echo "proxyB: $(tx "$LASNA_RPC" "$RC" 'setProxy(uint256,address)' 84532 $BASE_PROXY)"
echo "proxyU: $(tx "$LASNA_RPC" "$RC" 'setProxy(uint256,address)' 1301 $UNI_PROXY)"
T0S="[$(cast keccak 'Locked(uint64,address,uint256)'),$(cast keccak 'Minted(uint64,address,uint256)'),$(cast keccak 'Burned(uint64,address,uint256)'),$(cast keccak 'Released(uint64,address,uint256)'),$(cast keccak 'Seized(address,uint256)'),0]"
ROUTE="(0,84532,1301,$LB,$MN,1,0,2,$GB,$GU,$W,0x0000000000000000000000000000000000000000,$K)"
ADD=$(tx "$LASNA_RPC" "$RC" 'addRoute((uint8,uint256,uint256,address,address,uint8,uint8,uint8,address,address,uint32,address,uint32),uint256[6])' "$ROUTE" "$T0S")
echo "addRoute: $ADD"
{
  echo "INSTANCE=$INSTANCE"
  echo "ROUTE_ID=1"
  echo "RC=$RC"; echo "GATE_B=$GB"; echo "GATE_U=$GU"; echo "LOCKBOX=$LB"; echo "MINTER=$MN"
  echo "RELAYER=$DEPLOYER_ADDRESS"
  echo "W=$W"; echo "K=$K"
  echo "LASNA_FROM=$(cast block-number --rpc-url "$LASNA_RPC")"
  echo "BASE_FROM=$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC")"
  echo "UNI_FROM=$(cast block-number --rpc-url "$UNICHAIN_SEPOLIA_RPC")"
  echo "ADDROUTE_TX=${ADD%% *}"
  echo "COMMIT=$(git rev-parse --short HEAD)"
} > "$OUT"
cat "$OUT"
