#!/usr/bin/env bash
# Route B guard enrolment on the frozen deployment: two more Gates (Base + Unichain) whose targets are the Hyperlane PausableIsms
# of the warp route (ownership handed to the gates), a DrillBeacon, and one SUPPLY route in the existing LedgerlockReactive.
# Warp route + ISMs come from the Hyperlane CLI (evidence/route-b-addresses.txt, g2-hyperlane.csv).
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
source evidence/frozen-addresses.txt
source <(grep -E '^[A-Z_]+=' evidence/route-b-addresses.txt | sed 's/#.*//')
BASE_PROXY=0x476F44b11F5C942c58f4c8E3d0300E5710743585; UNI_PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1
LASNA=(--legacy --gas-price 100gwei)
create() { forge create "$2" --broadcast --rpc-url "$1" --private-key "$DEPLOYER_PRIVATE_KEY" --value "$3" --json "${@:4}" | sed -n "/^{/,\$p" | jq -r .deployedTo; }
G2B=$(create "$BASE_SEPOLIA_RPC" src/Gate.sol:Gate 0.0002ether --constructor-args $BASE_PROXY $RC $DEPLOYER_ADDRESS)
G2U=$(create "$UNICHAIN_SEPOLIA_RPC" src/Gate.sol:Gate 0.0002ether --constructor-args $UNI_PROXY $RC $DEPLOYER_ADDRESS)
DB=$(create "$BASE_SEPOLIA_RPC" src/DrillBeacon.sol:DrillBeacon 0)
snd() { cast send "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --json | jq -er 'if .status == "0x1" then .transactionHash+" "+.status else error("reverted: "+.transactionHash) end'; }
out=$(snd $G2B 'setTarget(address)' $BASE_PAUSABLE_ISM --rpc-url $BASE_SEPOLIA_RPC); echo "setTarget B: $out"
out=$(snd $G2U 'setTarget(address)' $UNI_PAUSABLE_ISM --rpc-url $UNICHAIN_SEPOLIA_RPC); echo "setTarget U: $out"
out=$(snd $BASE_PAUSABLE_ISM 'transferOwnership(address)' $G2B --rpc-url $BASE_SEPOLIA_RPC); echo "own B: $out"
out=$(snd $UNI_PAUSABLE_ISM 'transferOwnership(address)' $G2U --rpc-url $UNICHAIN_SEPOLIA_RPC); echo "own U: $out"
SENT=$(cast keccak 'SentTransferRemote(uint32,bytes32,uint256)'); RECV=$(cast keccak 'ReceivedTransferRemote(uint32,bytes32,uint256)'); DRILL=$(cast keccak 'Drill(uint256)')
T0S="[$SENT,$RECV,$SENT,$RECV,0,$DRILL]"
ROUTE="(1,84532,1301,$ROUTE_B_COLLATERAL_BASE,$ROUTE_B_SYNTHETIC_UNI,0,0,0,$G2B,$G2U,60,$DB,16)"
out=$(snd $RC 'addRoute((uint8,uint256,uint256,address,address,uint8,uint8,uint8,address,address,uint32,address,uint32),uint256[6])' "$ROUTE" "$T0S" --rpc-url $LASNA_RPC "${LASNA[@]}"); echo "addRoute: $out"
ROUTE_ID_B=$(cast call $RC 'routeCount()(uint256)' --rpc-url $LASNA_RPC | awk '{print $1}')   # route ids count up from 1, so the new route's id is the count
{ echo "ROUTE_ID_B=$ROUTE_ID_B"; echo "GATE_B2=$G2B"; echo "GATE_U2=$G2U"; echo "DRILL_BEACON=$DB"; echo "BASE_FROM_B=$(cast block-number --rpc-url $BASE_SEPOLIA_RPC)"; echo "UNI_FROM_B=$(cast block-number --rpc-url $UNICHAIN_SEPOLIA_RPC)"; echo "LASNA_FROM_B=$(cast block-number --rpc-url $LASNA_RPC)"; } | tee evidence/route-b-guard.txt
