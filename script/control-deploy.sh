#!/usr/bin/env bash
# Paired-control arm A0: the same fixture LockBox + Minter, but the gates are never driven (their RVM is a dead address and no
# route is registered in any guard), so nothing can pause them. Same collateral as route A. Writes evidence/a0-addresses.txt.
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
BASE_PROXY=0x476F44b11F5C942c58f4c8E3d0300E5710743585; UNI_PROXY=0x775c9B990ADe401060B78D0e98684eEf8d2466C1
DEAD=0x000000000000000000000000000000000000dEaD
COLLATERAL=${COLLATERAL:-100000000000000000000000}
create() { forge create "$2" --broadcast --rpc-url "$1" --private-key "$DEPLOYER_PRIVATE_KEY" --value "$3" --json --constructor-args "${@:4}" | sed -n "/^{/,\$p" | jq -er .deployedTo; }
GB=$(create "$BASE_SEPOLIA_RPC" src/Gate.sol:Gate 0 $BASE_PROXY $DEAD $DEPLOYER_ADDRESS)
GU=$(create "$UNICHAIN_SEPOLIA_RPC" src/Gate.sol:Gate 0 $UNI_PROXY $DEAD $DEPLOYER_ADDRESS)
LB=$(create "$BASE_SEPOLIA_RPC" src/fixture/LockBox.sol:LockBox 0 $GB $DEPLOYER_ADDRESS)
MN=$(create "$UNICHAIN_SEPOLIA_RPC" src/fixture/Minter.sol:Minter 0 $GU $DEPLOYER_ADDRESS)
out=$(cast send "$LB" 'seedCollateral(uint256)' "$COLLATERAL" --rpc-url "$BASE_SEPOLIA_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --json); s=$(echo "$out" | jq -er 'if .status == "0x1" then .transactionHash + " " + .status else error("reverted: " + .transactionHash) end'); echo "seed: $s"
{ echo "INSTANCE=a0"; echo "GATE_B=$GB"; echo "GATE_U=$GU"; echo "LOCKBOX=$LB"; echo "MINTER=$MN"; echo "RELAYER=$DEPLOYER_ADDRESS"; echo "COMMIT=$(git rev-parse --short HEAD)"; } > evidence/a0-addresses.txt
cat evidence/a0-addresses.txt
