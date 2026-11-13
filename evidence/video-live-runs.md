# Demo video runs (live, testnet, 2026-11-13 UTC)

Rows: `evidence/video-live-bench-runs.csv`, written by the same harness as the bench (`scripts/bench.ts`, run with
`BENCH_OUT=evidence/video-live-bench-runs.csv VERBOSE=1`) on the frozen3 deployment (route A, fixture bridge), while the
demo video was recorded. Seconds below = column `*_seen_ms` minus `mint_mined_ms` (observer clock, poll every
400 ms). These are three single runs shown on camera, not a rate; the headline numbers stay
`evidence/frozen3-bench-summary.md` (n=100).

## bu-101 · burst (forged mint, copycats, forged release) · outcome ok

| leg | observer seconds after the mint mined | tx |
|---|---|---|
| forged mint (key 1601000, 500 tUSD) mined on Unichain | 0 (t0) | 0xa96203cd51a5f656fed9cf9ed87ae0c64687ffdafae14a7ccf3b72e9c71964bf |
| Lasna `react()` with `PauseRequested` seen | 3.139 | 0xdd2591adb689809394165bfa5ffbc440ec83553372b4c2f01999a55a790fcb27 |
| gate B `Paused` seen (Base) | 2.210 | 0x5937c215e363a16be04733ba4907129a13dcca810a6bc8f5377c267cb413a22f |
| gate U `Paused` seen (Unichain) = both gates shut | 7.986 | 0xe452f91ef01f74e8d4849209d747ce5711dede5086a8f44a0773b50a282e2eec |
| copycats fired / landed before the stop | 2 / 1 | stopping revert 0x30019ac10497358c51d99f3396ed7c2c81daa3e384a5afa87646ce4a9fbe5669 |
| forged release on Base (carry-home) | reverted | 0x69e735fc72be66d45dddfa8dd4c725c5210889a0348fcbe2c6dca8ac731f22d6 |
| recovery (seize + owner `resolve()` + both gates reopened) | 14.85 s | |

On-chain order (receipts): the forged mint is Unichain block 67756408 (tx index 1); gate U `Paused` is Unichain block
67756410 (tx index 1); the stopping copycat reverted in the same block 67756410 at tx index 2, reason `GatePaused`
(`evidence/video-live-burst-verify.csv`); gate B `Paused` is Base block 58434842 and the forged release reverted in Base
block 58434855. Whole-second block timestamps: mint 1794608836, gate B 1794608837 (+1 s), gate U 1794608838 (+2 s).
So the observer's 7.986 s for gate U is an upper bound: its poll saw the log later than the chain held it.
The Lasna `react()` (block 8279221) carries two callbacks on Reactscan: https://lasna.reactscan.net/tx/0xdd2591adb689809394165bfa5ffbc440ec83553372b4c2f01999a55a790fcb27

## lf-104 · legit transfer sent out of order on purpose (mint first, lock 8 s later) · outcome ok

| leg | observer seconds after the mint mined | tx |
|---|---|---|
| mint (key 162, 500 tUSD) mined on Unichain, no lock yet | 0 (t0) | 0x521baf3ede83b18cf8b1f8ceec1dd6090e8cb4f6f899a4d4d9b72c3df405294d |
| gate B `Paused` seen | 6.846 | 0xa8f5d3422808878fea79b9dd8fe2b1d4cd34af843a54f8389c084b549878e896 |
| gate U `Paused` seen | 7.988 | 0x8650135cd93851c88acec6edcb68cbdee6227908cf62a53894550476fa49ee56 |
| its lock mined on Base | see `lock_tx` | 0x2523a4d0af01fd31a7345df3ab676aadf7c07833627ec8a1966b9d7052a34e92 |
| gate B `Resumed` by itself | 11.374 | |
| gate U `Resumed` by itself | 13.043 | |
| false-pause cost (longest one gate stayed shut, `pause_seconds`) | 5.1 s | |

`lf-101` is an earlier take of the same kind (lock 6 s after the mint, `pause_seconds` 5.0); it is kept as a
real row, and the video shows `lf-104`.
