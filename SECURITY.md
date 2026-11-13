# Security policy

Ledgerlock is a hackathon project (Reactive Omni Buildathon, testnet only: Reactive Lasna, Base Sepolia, Unichain Sepolia). It guards no real funds, and the contracts have not been audited.

## Reporting a vulnerability

Please open a private security advisory on this repository (Security tab → "Report a vulnerability"). If that is unavailable, open an issue titled "security" with no exploit details and we will move the discussion to a private channel.

Useful reports include a way to make a `Gate` miss a forged mint or a forged release, a way to spend another route's callback budget, or a way to make `react()` revert on attacker-chosen input.

## Scope

In scope: `src/` and `packages/reactive-kit/`. Out of scope: the sponsor libraries in `lib/`, Hyperlane contracts, and any mainnet deployment (there is none).

## Secrets

No keys are stored in this repository. CI runs gitleaks over the full history on every push.
