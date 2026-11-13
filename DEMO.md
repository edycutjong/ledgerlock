# Ledgerlock: demo and reproduction

Everything below runs on testnets (Reactive Lasna 5318007, Base Sepolia 84532, Unichain Sepolia 1301). Route A is our own
fixture bridge, labelled as such. Numbers come from `evidence/frozen3-bench-summary.md`, generated from
`evidence/frozen3-bench-runs.csv`.

## 1. One attack, as a triple (read-only to verify)

Run `bu-021` (burst, route A, instance `frozen3`): a forged mint of 500 tUSD on Unichain Sepolia with no lock behind it.

| Step | Transaction | Observer time after the mint was mined |
|---|---|---|
| Forged mint mined (Unichain Sepolia) | `0x4bfe94f268205f7918c3396c6b76ca21f60ebd5c800cc138516650d238f8a84e` | 0 s |
| Lasna `react()` seen | `0xbacbf5a0da2c6adf9e89f0b950dd078e707459bfbc916794826f627a03059068` | 3.175 s |
| Gate B `Paused` (Base Sepolia) | `0x5eacdc824b92a2c83498d64e7511dd97fb9fb3a340f1baa4f24417b351a14303` | 2.184 s |
| Gate U `Paused` (Unichain Sepolia) | `0x60f4bcba2e0bbd4c2d26f2e02855e27ab5c6103c200b73b5588427970c25f3c4` | 8.062 s |

Copycats fired 2, landed 1, the second reverted `GatePaused`; exposure 1,000 tUSD (the forged mint plus one copycat, 500 tUSD each).
One `react()` carries both pause callbacks. Gate B shows earlier than the Lasna `react()` which we attribute to Lasna RPC visibility lag (not measured separately; block timestamps never invert); the block timestamps are the causal check. Times are the observer's wall clock (poll every 400 ms plus RPC delay); the same run's
block timestamps are mint 1794595469, Gate B 1794595470, Gate U 1794595471.

All 846 triple rows (636 origin → `react()`, 210 owner `resolve()` → resume; 500 with a gate callback leg) are in `evidence/frozen3-triples.csv`.

## 2. Bench results (frozen3, contract `e425c78`)

| Metric | Value |
|---|---|
| Attack runs (60 forged + 20 plausible + 20 burst) | 100 |
| Detection (mint mined → Lasna react seen) | p50 3.873 s · p95 4.391 s · max 6.545 s |
| Pause, Unichain gate | p50 5.917 s · p95 8.245 s · max 10.97 s |
| Pause, Base gate | p50 3.378 s · p95 7.079 s · max 7.132 s |
| Both gates shut | p50 5.92 s · p95 8.245 s |
| Block-timestamp cross-check (Unichain, whole seconds) | p50 2 s · p95 3 s · max 3 s |
| False pauses, 80 strict legitimate transfers | 0 |
| Forced fill-before-deposit pauses (n=19; `lf-019` has no duration, named in the summary) | p50 15.2 s · p95 23.1 s |
| Recovery (seize + resolve + both gates reopened) | p50 14.593 s · p95 15.345 s |
| Bursts (20) | all stopped at the first reverted copycat; copycats landed p50 1 · max 1; burst-verify 20 of 20 |
| Pause audit | 125 `PauseRequested` joined to runs, 0 unmatched |

Paired control (5 runs per arm, same attack, one forged 500 tUSD release on Base after the mint):

| Arm | Copycats landed | Unauthorized tUSD issued (per run) | Collateral released to the attacker (per run) |
|---|---|---|---|
| A0, unguarded copy of route A (`evidence/a0-control-runs.csv`) | 6 | 3,500 | 500 (succeeded) |
| A, guarded (`bu-021`..`bu-025`) | 1 | 1,000 | 0 (reverted) |

The unguarded arm fires a fixed 6 copycats while the guarded burst fires up to 30 and stops at the first revert, so issuance is an
illustration, not a like-for-like rate. The claim stays: loss ≤ the mints that land inside the pause window.

Route B (Hyperlane warp route, self-delivered by our own `Mailbox.process`): 10 legitimate transfers with 0 false latches, and 3
owner drills (`DrillBeacon.fire()`), not attacks. Drill pause latencies are in `evidence/frozen3-bench-summary.md`, route B section.

## 3. Test Lib output

```bash
forge test
# Suite result: ok. 83 passed; 0 failed; 0 skipped
FOUNDRY_PROFILE=kit forge test
# 23 tests passed, 0 failed (4 suites)
pnpm test:ts
```

Named tests that carry the claims (`test/LedgerlockReactive.t.sol`), all `[PASS]`:
`test_unmatched_mint_end_to_end_gates_shut_and_copycat_reverts`, `test_nomad_release_pauses_both` (release direction, a fixture),
`test_gate_rejects_spoofed_callbacks`, `test_reorged_lock_is_simulated_passes_as_matched` (reorg is a simulation, labelled).

## 4. Reproduce

Regenerate every table above from the committed rows (no keys, no network):

```bash
git submodule update --init --recursive
pnpm install
pnpm bench:summary          # evidence/frozen3-bench-summary.{md,json}
pnpm burst:verify           # re-checks the 25 burst rows (20 headline + 5 paired-control) by public RPC reads (needs network, no keys)
```

Re-run the live bench against your own deployment (needs funded testnet keys, ~25 lREACT (Lasna's gas token) on Lasna and a little Base and Unichain Sepolia ETH):

```bash
export LEDGERLOCK_ENV=~/.config/<you>/testnet.env     # deployer key + RPC URLs; never commit it
INSTANCE=mine script/core-deploy.sh                     # deploys the reactive contract, gates, fixture route
script/bench-all.sh mine                                # 100 legit + 100 attacks, resumable (`pnpm bench` runs it for frozen3)
pnpm bench:summary
```

Single actions use `script/core-trigger.sh` (`legit`, `attack <nonce> <to> <amount_wei>`, `resolve`, `state`; usage is in its header; `INSTANCE=mine` selects your deployment).

Every run row lists the origin, Lasna and gate transaction hashes, so each figure can be checked on the block explorers.
