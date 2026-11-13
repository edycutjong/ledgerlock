# Ledgerlock

Pause-first guard for lock-and-mint bridges, built on **Reactive Network Omni** (Lasna testnet).

A reactive contract on Lasna reads both sides of a bridge route itself: `Locked` on the source chain (Base Sepolia)
and `Minted` on the destination chain (Unichain Sepolia). A mint whose lock it has not seen pauses **both** gates
from the same `react()`; the matching lock arriving later reopens them. Locks and matched mints cost no callback.

> Work in progress (spike stage). The bridge on the attack path is a **fixture** we wrote (`src/fixture/`), labelled
> as such. Live transactions so far: `evidence/triples.csv`.

## Layout

| Path | What |
|---|---|
| `src/LedgerlockReactive.sol` | the reactive contract (Lasna) |
| `src/Gate.sol` | the pause switch on each chain (callback target) |
| `src/fixture/` | `LockBox` (Base Sepolia) and `Minter` (Unichain Sepolia): the route A fixture |
| `src/probe/` | dev-deployment probe contracts |
| `packages/reactive-kit/` | shared Omni building blocks (see its README for provenance) |
| `evidence/` | committed raw rows from live runs |

## Test

```bash
git submodule update --init --recursive
forge test                       # contracts (Reactive Test Lib + reactive-kit Omni harness)
FOUNDRY_PROFILE=kit forge test   # reactive-kit's own tests
```

## License

MIT
