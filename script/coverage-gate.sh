#!/usr/bin/env bash
# Coverage gate: every deployed Solidity source must be 100% lines, statements, branches and functions.
#   default profile -> src/                      (Gate, LedgerlockReactive, fixture, probe, DrillBeacon)
#   kit profile     -> packages/reactive-kit/src (AbsenceWatch, AckLedger, CallbackFailureWatch, CronTopics)
# Tests, scripts, lib/ and the kit's test helpers (packages/reactive-kit/src/test/) are excluded.
set -euo pipefail
cd "$(dirname "$0")/.."

gate() {
  local label="$1" profile="$2" exclude="$3" out
  out=$(FOUNDRY_PROFILE="$profile" "${FORGE:-forge}" coverage --report summary --no-match-coverage "$exclude" 2>&1) || {
    echo "$out"; echo "::error::forge coverage failed ($label)"; return 1; }
  echo "$out" | grep -E '^\| [^-]'
  local total n
  total=$(echo "$out" | grep -E '^\| Total')
  n=$(echo "$total" | grep -o '100.00%' | wc -l | tr -d ' ')
  if [ "$n" -ne 4 ]; then echo "::error::$label coverage is below 100%: $total"; return 1; fi
  echo "OK  $label: 100% lines, statements, branches, functions"
}

gate "src/" default '(script|test|lib|packages)/'
gate "packages/reactive-kit/src" kit '(script|test|lib)/'
