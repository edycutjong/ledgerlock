<div align="center">
  <img src="docs/assets/brand/icon-animated.svg" alt="Ledgerlock — pauses a bridge seconds after it mints what was never locked" width="112">
  <h1>Ledgerlock</h1>
  <p><em>Two chains, one book: pause a bridge seconds after it mints what was never locked.</em></p>
  <img src="docs/assets/brand/readme-hero-animated.svg" alt="Ledgerlock — pauses a bridge seconds after it mints what was never locked. Minted on Unichain, never locked on Base: one react() turns both lamps from white to red, shutting both gates." width="100%">
  <p><b>One Reactive Omni contract on Lasna sees Base <code>Locked</code> and Unichain <code>Minted</code> together, which a contract on either chain cannot.</b> Measured live on our own fixture bridge (observer clock, polled every 400 ms; the on-chain block-timestamp check is p50 2 s / p95 3 s): a mint with no lock is seen on Lasna in <b>3.873 s</b> (p50) and both gates are shut by <b>8.245 s</b> (p95), over 100 attack runs, with <b>0 false pauses in 80</b> legitimate transfers. Regenerate from the committed rows: <code>pnpm bench:summary</code>.</p>

  <br/>

  [![Live Demo](https://img.shields.io/badge/🚀_Live-Demo-06b6d4?style=for-the-badge)](https://edycutjong.github.io/ledgerlock/)
  [![For Judges](https://img.shields.io/badge/⚖️_For-Judges-e4412a?style=for-the-badge)](https://edycutjong.github.io/ledgerlock/judge)
  [![Pitch Deck](https://img.shields.io/badge/📊_Pitch-Deck-f59e0b?style=for-the-badge)](https://edycutjong.github.io/ledgerlock/pitch/)
  [![Built for Reactive Omni Buildathon](https://img.shields.io/badge/DoraHacks-Reactive_Omni_Buildathon-8b5cf6?style=for-the-badge)](https://dorahacks.io/hackathon/reactive-omni-buildathon/detail)

  <br/>

  ![Solidity](https://img.shields.io/badge/Solidity-363636?style=flat&logo=solidity)
  ![Foundry](https://img.shields.io/badge/Foundry-tested-orange?style=flat)
  ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
  [![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
  [![CI](https://github.com/edycutjong/ledgerlock/actions/workflows/ci.yml/badge.svg)](https://github.com/edycutjong/ledgerlock/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/edycutjong/ledgerlock?sort=semver)](https://github.com/edycutjong/ledgerlock/releases/latest)

  <p><b>Judging?</b> Start at <a href="https://edycutjong.github.io/ledgerlock/judge">/judge</a> (<a href="JUDGE.md">JUDGE.md</a>): one forged mint, one Lasna <code>react()</code>, both gates paused, the copycat reverted, in six explorer links. No wallet needed.</p>

</div>

---

## 💡 The Problem & Solution

### The Problem
Lock-and-mint bridges fail by minting (or releasing) value that was never backed. When it happens, copycats replay the exploit every block until a human notices. The Nomad bridge lost about $190M this way, over roughly two and a half hours (Rekt, Immunefi; transaction counts are Halborn only). A guard has to see **both** chains, which a contract on one chain cannot do.

### The Solution
A reactive contract on Reactive Lasna keeps a ledger per route from the logs of both sides: `Locked` on Base Sepolia, `Minted` on Unichain Sepolia (and `Burned` / `Released` for the way back). The logic is inverted so the common case costs nothing:

- a `Minted` with no matching `Locked` pauses **both** gates from the same `react()`, via two callbacks;
- a matching `Locked` arriving inside the window `W` (60 s on our routes, set per route) reopens them automatically;
- a lock that arrives before its mint, and the mint that matches it, trigger no callback at all; only a lock that clears an unmatched mint sends the resume callbacks.

Each gate is a small contract that flips the bridge's own pause switch. **Why Omni:** a guard on Base never sees `Minted`, and a guard on Unichain never sees `Locked`; one Lasna contract reads both (no off-chain watcher; we did not measure a baseline). The claim we make is deliberately narrow: **loss ≤ the mints that land inside the measured pause window.** Ledgerlock does not stop the first unbacked mint.

## 🏗️ Architecture & Tech Stack

<img src="docs/architecture.png" alt="Ledgerlock architecture: one reactive contract on Lasna reads both sides of a route and pauses a gate on each chain" width="100%">

Source: `docs/architecture.svg`.

| Layer | Choice |
|---|---|
| Reactive contract | `src/LedgerlockReactive.sol`, `reactive-lib-omni`, Lasna 5318007 |
| Gates | `src/Gate.sol` (`AbstractCallback`) on Base Sepolia 84532 and Unichain Sepolia 1301 |
| Route A | our own fixture bridge (`src/fixture/LockBox.sol`, `Minter.sol`), labelled as a fixture, with a Nomad-class release bug reproduced on demand |
| Route B | a Hyperlane warp route we deployed (`PausableIsm` = Hyperlane's pausable interchain security module) (Base collateral → Unichain synthetic) with a `PausableIsm` behind the gate; deliveries were made by **our own `Mailbox.process`**, because the public relayer did not deliver within 6 minutes |
| Tests | Foundry with the Reactive Test Lib; scripts in TypeScript (viem) |
| Status page | static, `docs/status/`, reads the committed rows |

`tUSD` is the fixture's unit of account (internal bookkeeping, not an ERC-20) and lREACT is Lasna's gas token. Two guard instances: route A is guarded by `frozen3` (the final frozen deployment) and route B by `frozen` (its `PausableIsm` is owned by `frozen`'s gates, which have no ownership transfer). Per-route addresses: `deployments/testnet.json`.

## 🏆 Reactive Omni Integration

The reactive contract uses the Omni system contract directly (`src/LedgerlockReactive.sol`):

| Method | Use |
|---|---|
| `subscribe` | origin logs on both chains, each gate's `Paused` / `Resumed` / `HeldByGuardian`, and `CallbackFailure` on both callback proxies (`:233`, `:244`) |
| `requestCallbackV_1_0` | the pause / resume callbacks to the gates, gas limit 1,000,000 (`:520`) |
| `subscribe` / `unsubscribe` on the Cron10 topic | a runtime-only watchdog while a gate ack is outstanding (`:500`, `:536`) |
| `AbstractReactive` / `AbstractCallback` | base contracts for the reactive contract and the gates |

No off-chain ingestion is used. One behaviour is not in the docs: origin logs are read at the latest block, which the Reactive team told us in their dev Telegram on 8 Nov 2026 (we cannot publish that message here).

## ⛓️ Live Deployment

Testnet only; no wallet is needed to verify anything below, every item is a read-only lookup. Route A (`frozen3`, contract commit `e425c78`):

| Contract | Address |
|---|---|
| `LedgerlockReactive` (Lasna) | `0x1484bdBF890f3097069C95Dc55EB6C6BF9039Ff9` |
| Gate (Base Sepolia) | `0xE77A8068882d157bE15bcd6CfbD6D93703E7634d` |
| Gate (Unichain Sepolia) | `0x6533d804Ef6D70765b981931083Fd332D4F78ef1` |
| LockBox (Base Sepolia) / Minter (Unichain Sepolia) | `0x871b6da60da6Cf44482a055EE24031220021873F` / `0x7be8C4bf9De88Cc037F61203C8692E3514ec4e90` |

Landing page, pitch deck and read-only status page: <https://edycutjong.github.io/ledgerlock/> (GitHub Pages from `docs/`; `/pitch/`, `/status/`). Route B's addresses are in `deployments/testnet.json`. Explorers: [Base Sepolia](https://sepolia.basescan.org), [Unichain Sepolia](https://sepolia.uniscan.xyz), [Lasna](https://lasna.reactscan.net).

Every pause is a triple: origin transaction → Lasna `react()` → gate callback. `evidence/frozen3-triples.csv` has 846 rows, one per callback leg (or one row where no callback is sent): 636 origin-log rows (491 distinct origin transactions) joined to their Lasna `react()`, plus 210 owner-`resolve()` rows (105 `resolve()` calls, one row per resume leg); 500 of the 846 carry a gate callback (500 of 500 callback legs joined: 250 pause legs = 125 `react()`s × 2 gates, 40 auto-resume legs, 210 resolve-driven resume legs) and 0 `CallbackFailure`. The other 346 rows send no callback: 140 locks, 80 matched mints, 105 seizures, 21 mints that arrived while the gates were already paused.

## 📊 Engineering Rigor

| Metric | Value | Source |
|---|---|---|
| Foundry tests | 113 passing; `src/` at 100% lines, statements, branches and functions | `forge test`, `pnpm coverage:sol` |
| reactive-kit tests | 29 passing (Solidity), 80 passing (TS); both at 100% coverage | `FOUNDRY_PROFILE=kit forge test`, `pnpm test:coverage` |
| Property test (queue head never rests on a cleared entry) | 262,144 random steps (4,096 runs × 64 ops) | `testFuzz_queue_head_never_rests_on_a_cleared_entry` |
| Detection (mint mined → Lasna react seen) | p50 3.873 s · p95 4.391 s · max 6.545 s (n=100) | `evidence/frozen3-bench-summary.md` |
| Pause, Unichain gate | p50 5.917 s · p95 8.245 s (n=100) | same |
| Pause, Base gate | p50 3.378 s · p95 7.079 s (n=100) | same |
| Both gates shut | p50 5.92 s · p95 8.245 s · max 10.97 s | same |
| False pauses, strict legitimate transfers | 0 of 80 | same |
| Forced fill-before-deposit pauses (lock sent 2–20 s after the mint, by design) | n=19, p50 15.2 s, p95 23.1 s (1 of 20 left out, no duration) | same |
| Recovery (seize + resolve + both gates reopened) | p50 14.593 s · p95 15.345 s (n=100) | same |
| Burst runs | 20 of 20 stopped at the first reverted copycat; at most 1 copycat landed | same; `evidence/frozen3-burst-verify.csv` |
| Paired control (5 runs per arm) | unguarded: 6 copycats landed, 3,500 tUSD issued, 500 tUSD of collateral released; guarded: 1 copycat landed, 1,000 tUSD issued, release reverted | `evidence/a0-control-runs.csv`, `evidence/frozen3-bench-runs.csv` (`bu-021`..`bu-025`) |

Lasna's `react()` is polled on a different RPC than the gates, so its first-seen time can trail the gate it triggered: the Base gate was seen before the Lasna `react()` in 66 of 100 runs, while block timestamps never invert (0 of 100). We attribute this to Lasna RPC visibility lag, which we did not measure separately; the block-timestamp row is the causal check. Latencies are first-seen times through public RPCs on one observer clock (poll every 400 ms plus RPC delay), not on-chain block times. The on-chain cross-check, whole-second Unichain block timestamps from the mint block to the gate's `Paused` block, is p50 2 s · p95 3 s. The guarded and unguarded control arms use different copycat schedules, so their issuance figures illustrate the effect and are not a like-for-like rate.

### Attacks defeated

| Control | Why load-bearing | Test (`test/LedgerlockReactive.t.sol`) |
|---|---|---|
| Unmatched mint pauses both gates; the next copycat reverts | the whole product | `:213` |
| Forged keys pause once, then latch | one forger cannot make the guard spend callbacks per mint | `:234` |
| A plausible forged nonce holds the route shut until the owner resolves | fail closed, never silently reopen | `:385` |
| Gate rejects spoofed callbacks | only the proxy-delivered request from our contract can pause | `:646` |
| Spoofed `CallbackFailure` logs ignored | any Lasna contract could otherwise forge failure logs for our gates (found in our adversarial review rounds) | `:1126` |
| Nomad-class release without burn pauses both | the release-direction replay (fixture) | `:773` |
| Callback failure retries once, then ends in `GateUnreachable` | a dead gate is visible, not silent | `:510`, `:527` |
| Accumulator overflow pauses instead of reverting `react()` | a revert would blind the guard | `:1067` |

### Honest limits (9)

1. If Reactive Lasna stops, Ledgerlock is blind and the bridge runs on its own security. If Base ingestion stops it fails closed; if Unichain ingestion stops, that side fails open until ingestion resumes.
2. Mints that land before the pause are lost. The guard does not prevent the first one.
3. The window, not the count, is the guard's property: a faster attacker (many transactions per block from a stolen key) lands more mints in the same window. Token exposure is bounded only if the bridge also caps the amount per message.
4. A forger who picks a plausible nonce holds the route shut until the owner resolves it (fail closed): legitimate mints wait.
5. Route A is our own fixture with a deliberately reproduced bug class. Route B is our own warp route and `PausableIsm`, delivered by our own `Mailbox.process`, not a third-party relayer.
6. Reorg handling is shown in simulation only (Test Lib, labelled).
7. The hop-sensitivity measurement is dropped: two Lasna self-callback requests were never delivered, so no hop rows exist.
8. Nothing pages the operator. A latched route stays shut until someone looks; the `IncidentLatched` and `GateUnreachable` events are the signals to watch.
9. Trusted and not covered: the bridge must emit truthful, complete events and check the gate independently of the compromised key; an upgrade that bypasses the gate, routes live before the guard was armed, and a single large mint before the pause are out of scope.

## 🚀 Getting Started

### Prerequisites
[Foundry](https://book.getfoundry.sh/), Node 20+ and pnpm.

### Installation
```bash
git submodule update --init --recursive && pnpm install
forge test                       # 113 contract tests (Reactive Test Lib)
pnpm bench:summary               # regenerate the numbers from evidence/frozen3-bench-runs.csv
```

Re-running the live bench needs your own funded testnet keys; steps are in [DEMO.md](DEMO.md).

## 🧪 Testing & CI

```bash
forge test && FOUNDRY_PROFILE=kit forge test   # 113 + 29 Solidity tests on the Reactive Test Lib
pnpm coverage:sol                               # fails below 100% on src/ or packages/reactive-kit/src
pnpm typecheck && pnpm test:coverage            # 80 TypeScript unit tests (reactive-kit helpers), 100% thresholds
pnpm e2e                                        # Playwright: landing, /judge, deck, status page, release tag, 375/768/1440 px
```

Every push to main and every pull request runs a six-stage pipeline (`.github/workflows/ci.yml`):

| Stage | What runs |
|---|---|
| 1 · Quality | `forge fmt --check test/`, `forge build --sizes`, both test profiles, the 100% coverage gate; `tsc`, vitest at 100%, and `pnpm bench:summary` must regenerate the committed summary byte for byte |
| 2 · Security | gitleaks over every commit, Slither (`--fail-high`; one detector excluded, its single finding triaged in [SECURITY.md](SECURITY.md)), `pnpm audit` |
| 3 · Build | the Pages site with the latest release tag stamped in and every local link checked |
| 4 · E2E | Playwright on desktop and mobile Chrome |
| 5 · Performance | Lighthouse CI (advisory) |
| 6 · Deploy gate | main only, needs every stage; `pages.yml` then deploys `docs/` |

CodeQL scans the TypeScript and the workflows; Dependabot (grouped, monthly; npm major bumps excluded; no submodule ecosystem, so `lib/` stays pinned and the deployed bytecode keeps matching the source), secret scanning and push protection are on. The coverage work added tests only: `git diff e425c78 -- src packages/reactive-kit/src` is empty, so the frozen3 contracts still match this source.

## 📁 Project Structure

| Path | What |
|---|---|
| `src/` | `LedgerlockReactive.sol`, `Gate.sol`, `DrillBeacon.sol`, `fixture/` (route A), `probe/` |
| `packages/reactive-kit/` | shared Omni building blocks; copied from the same author's Heirloom repo (MIT; see its README), identical apart from line-wrapping in the two `src/test` harness files; the kit tests are this repo's own versions |
| `script/`, `scripts/` | deploy and trigger shell scripts; bench, summary and join scripts |
| `evidence/` | committed raw rows from live runs; start with `evidence/README.md` |
| `docs/` | landing page (`index.html`), judge page (`judge.html`), pitch deck (`pitch/`), read-only status page (`status/`), architecture diagram |
| `deployments/testnet.json` | per-route addresses |
| `test/`, `e2e/` | Foundry tests (Reactive Test Lib) and Playwright tests for the Pages site |
| `JUDGE.md` | the judge path, mirrored at `/judge` on the Pages site |

## 📄 License

MIT
