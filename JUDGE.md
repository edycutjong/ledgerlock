# Ledgerlock for judges

Live page: https://edycutjong.github.io/ledgerlock/judge

**One Reactive contract reads Base locks and Unichain mints together and pauses a bridge seconds after a mint appears with no lock.**

Testnet only (Reactive Lasna 5318007, Base Sepolia 84532, Unichain Sepolia 1301). No wallet, no login, no clone: every step below is a
read-only explorer link. Route A is our own fixture bridge, labelled as one.

## The 30-second path

Run `bu-021` on the final deployment `frozen3` (contract commit `e425c78`): a forged mint of 500 tUSD on Unichain Sepolia with no lock
behind it on Base.

1. **The forged mint lands on Unichain Sepolia** (block 67743041): a `Minted` with no matching `Locked` on Base.
   [`0x4bfe94f2…a84e`](https://sepolia.uniscan.xyz/tx/0x4bfe94f268205f7918c3396c6b76ca21f60ebd5c800cc138516650d238f8a84e)
2. **One `react()` on Lasna sees it**, seen 3.175 s after the mint was mined; the same transaction emits two `CallbackRequest` logs, one per gate.
   [`0xbacbf5a0…9068`](https://lasna.reactscan.net/tx/0xbacbf5a0da2c6adf9e89f0b950dd078e707459bfbc916794826f627a03059068)
3. **Both gates are paused**: Base at 2.184 s, Unichain at 8.062 s (observer clock). Block timestamps: mint 1794595469, gate B 1794595470,
   gate U 1794595471. Gate B is seen before the Lasna transaction, which we attribute to Lasna RPC visibility lag (not measured
   separately); block timestamps never invert.
   Gate B [`0x5eacdc82…4303`](https://sepolia.basescan.org/tx/0x5eacdc824b92a2c83498d64e7511dd97fb9fb3a340f1baa4f24417b351a14303) ·
   Gate U [`0x60f4bcba…f3c4`](https://sepolia.uniscan.xyz/tx/0x60f4bcba2e0bbd4c2d26f2e02855e27ab5c6103c200b73b5588427970c25f3c4) (block 67743043)
4. **The next copycat reverts `GatePaused`** (block 67743044) and **the release on Base reverts too**. Exposure: 1,000 tUSD (the forged mint
   plus one copycat that landed before the pause).
   Copycat [`0x6006802e…2fb6`](https://sepolia.uniscan.xyz/tx/0x6006802eb3eab302322d15af5c2281feee3378b58e65750b1258997bced12fb6) ·
   Release [`0x80ff77c4…9bfb`](https://sepolia.basescan.org/tx/0x80ff77c4362d72a8aa9eddfb02013e20f0831be315baa1cadc631c6cb07e9bfb)
5. **Open the [live status page](https://edycutjong.github.io/ledgerlock/status/)**: it reads both gates' state from the public testnet
   RPCs and lists every committed run with its hashes.

## Receipt

| What | Value | Source |
|---|---|---|
| Detection (mint mined → Lasna `react()` seen) | p50 3.873 s · p95 4.391 s (n=100 attack runs) | `evidence/frozen3-bench-summary.md` |
| Both gates seen shut | p50 5.92 s · p95 8.245 s | same |
| On-chain cross-check (Unichain block timestamps, mint → gate `Paused`) | p50 2 s · p95 3 s | same |
| False pauses, strict legitimate transfers | 0 of 80 | same |
| Bursts | 20 of 20 stopped at the first reverted copycat; at most 1 copycat landed | `evidence/frozen3-burst-verify.csv` |
| Triples (origin → Lasna `react()` → gate callback) | 846 rows; 500 of 500 callback legs joined; 0 `CallbackFailure` | `evidence/frozen3-triples.csv` |
| Paired control (5 runs per arm, same forged 500 tUSD mint, different copycat schedules) | unguarded: 6 copycats landed, 3,500 tUSD issued, 500 released · guarded: 1 landed, 1,000 issued, release reverted | `evidence/a0-control-runs.csv` |
| Tests | 113 contract + 29 reactive-kit Solidity tests (100% lines, statements, branches, functions on `src/` and the kit); 80 TypeScript unit tests on the reactive-kit helpers at 100%; one property test checks 262,144 random queue steps | `forge test`, `pnpm test:coverage` |

The control arms use different copycat schedules, so issuance illustrates the effect rather than a like-for-like rate.

## Reproduce

Re-check the live runs on-chain (public RPC reads, no keys):

```sh
git clone --recurse-submodules https://github.com/edycutjong/ledgerlock.git && cd ledgerlock
pnpm install
pnpm burst:verify     # re-reads the 25 burst rows (20 headline + 5 paired control) from the chains
pnpm bench:summary    # regenerates the latency, false-pause and burst numbers from evidence/frozen3-bench-runs.csv
```

Re-run the attack bench live on your own deployment (funded testnet keys, about 25 lREACT): see [DEMO.md](DEMO.md) §4
(`INSTANCE=mine script/core-deploy.sh`, then `script/bench-all.sh mine`).

CI / deterministic replay (Reactive Test Lib, no network): `forge test && FOUNDRY_PROFILE=kit forge test && pnpm test:coverage`.

## Honest limits

- **The first unbacked mint is lost.** Ledgerlock limits the loss to the mints that land inside the measured pause window; it does not
  prevent the first one.
- **Both routes are ours.** Route A is our own fixture bridge with a reproduced Nomad-class bug; route B is our own Hyperlane warp route,
  delivered by our own `Mailbox.process` because the public relayer did not deliver within 6 minutes.
- **If Lasna stops, the guard is blind**, and nothing pages the operator: a latched route stays shut until someone looks at the
  `IncidentLatched` and `GateUnreachable` events.

All nine limits are in the [README](README.md#honest-limits-9).

## Links

[Repository](https://github.com/edycutjong/ledgerlock) · [Landing page](https://edycutjong.github.io/ledgerlock/) ·
[Pitch deck](https://edycutjong.github.io/ledgerlock/pitch/) · [Live status page](https://edycutjong.github.io/ledgerlock/status/) ·
[DEMO.md](DEMO.md) · [evidence/](evidence/) · [Releases](https://github.com/edycutjong/ledgerlock/releases/latest)
