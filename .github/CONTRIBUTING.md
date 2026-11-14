# Contributing to Ledgerlock

Thanks for helping. Ledgerlock pauses a bridge on two chains from one Reactive contract, so changes to `src/` get extra
scrutiny: a guard that pauses wrongly or not at all is worse than no guard.

## Getting Started
```sh
git clone --recurse-submodules https://github.com/edycutjong/ledgerlock.git
cd ledgerlock
pnpm install
forge test                              # contract tests on the Reactive Test Lib (no network, no keys)
FOUNDRY_PROFILE=kit forge test          # reactive-kit Solidity tests
pnpm typecheck && pnpm test:coverage    # TypeScript kit, 100% coverage thresholds
pnpm bench:summary                      # regenerate the headline numbers from evidence/frozen3-bench-runs.csv
```

## Before You Open a PR
- `forge fmt --check`, `forge test` and `FOUNDRY_PROFILE=kit forge test` pass; `pnpm coverage:sol` keeps `src/` and
  `packages/reactive-kit/src/` at 100% lines, statements, branches and functions.
- `pnpm typecheck`, `pnpm test:coverage` (100% thresholds) and `pnpm e2e` (Playwright, landing + judge + status pages) pass.
- Name new tests after the behaviour or defect they pin (`test_a2a_spoofed_callback_failure_ignored`).
- Commit messages follow Angular conventions (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`); `release.yml` derives
  the semantic version from them.
- The testnet deployments listed in `evidence/*-addresses.txt` were built from this source. A change to `src/` means a
  new deployment and a new bench run, not an edit of the live one; say so in the PR. The `lib/` submodules stay pinned.
- Never commit a key. Scripts read them from `$LEDGERLOCK_ENV` outside the repo (see `.env.example`).

## Reporting Bugs / Requesting Features
Use the issue templates. Security issues go through private vulnerability reporting, see [SECURITY.md](../SECURITY.md).
