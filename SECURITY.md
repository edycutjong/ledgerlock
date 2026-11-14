# Security policy

Ledgerlock is a hackathon project (Reactive Omni Buildathon, testnet only: Reactive Lasna, Base Sepolia, Unichain Sepolia). It guards no real funds, and the contracts have not been audited.

## Reporting a vulnerability

Please open a private security advisory on this repository (Security tab → "Report a vulnerability"). If that is unavailable, open an issue titled "security" with no exploit details and we will move the discussion to a private channel.

Useful reports include a way to make a `Gate` miss a forged mint or a forged release, a way to spend another route's callback budget, or a way to make `react()` revert on attacker-chosen input.

## Scope

In scope: `src/` and `packages/reactive-kit/`. Out of scope: the sponsor libraries in `lib/`, Hyperlane contracts, and any mainnet deployment (there is none).

## Static analysis

CI Stage 2 runs Slither 0.11.5 over `src/` and fails on any High finding except two, triaged here:

| Detector | Where | Why it is not a defect |
|---|---|---|
| `uninitialized-state` | `src/fixture/LockBox.sol` `messages` | the fixture's deliberate Nomad-class bug: a never-proven message maps to root 0, which `initialize(bytes32(0))` marks acceptable. Route A is labelled as a fixture; Ledgerlock's job is to pause it. |
| `reentrancy-eth` | `src/LedgerlockReactive.sol` | the external calls go to the Reactive system contract (`subscribe`, `unsubscribe`, `requestCallbackV_1_0`) at a fixed address, not to user-supplied contracts |

CodeQL scans the TypeScript and the workflows. `src/` and `packages/reactive-kit/src/` are held at 100% line, statement, branch and function coverage by `script/coverage-gate.sh`.

## Secrets

No keys are stored in this repository. CI runs gitleaks over the full history on every push and weekly; GitHub secret scanning and push protection are on. Scripts read keys from `$LEDGERLOCK_ENV`, outside the repo (see `.env.example`).
