#!/usr/bin/env bash
# Full bench on one deployment: 100 legit (80 strict + 20 forced fill-before-deposit) + 100 attacks (60 forged + 20 burst + 20 plausible).
# Resumable: finished run ids are skipped. Usage: script/bench-all.sh <instance>
set -euo pipefail
set -a; source "${LEDGERLOCK_ENV:-$HOME/.config/reactive/testnet-deployer.env}"; set +a
cd "$(dirname "$0")/.."
I=${1:-frozen3}
npx tsx scripts/bench.ts "$I" legit_strict 80
npx tsx scripts/bench.ts "$I" legit_forced 20
npx tsx scripts/bench.ts "$I" attack_forged 60
npx tsx scripts/bench.ts "$I" burst 20
npx tsx scripts/bench.ts "$I" attack_plausible 20
