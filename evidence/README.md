# evidence/

Raw rows from live runs on Reactive Lasna + Base Sepolia + Unichain Sepolia, regenerated from chain logs. Nothing here is
typed by hand except the actions files (`core-dev-actions.csv`, `core-dev2-actions.csv`, `spike-actions.csv`), which the trigger scripts append as they send each transaction.

Both instances below are **dev deployments**: their gates are `ProbeGate`s (a `Gate` plus a forced-failure flag the
guardian can set). The final numbers cite the later `frozen3` (route A) and `frozen` (route B) deployments, listed in `deployments/testnet.json`; their files are `frozen3-*` / `frozen-*`.

## Instance `core-dev` (core flow; `scripts/triples.ts`, `pnpm triples:core`)

Addresses, start blocks and the source commit (`COMMIT=`) are in `core-dev-addresses.txt`; deployed by
`script/core-deploy.sh`, driven by `script/core-trigger.sh`. The deployed bytecode is `src/` at that commit; later
fixes in `src/` are covered by the Test Lib suite and reach the chain with the next deployment, not this one.

| File | Rows |
|---|---|
| `core-dev-triples.csv` | origin tx → Lasna `react()` tx → gate callback tx, one row per callback leg of each pause/resume request (no-op rows have no callback; a leg whose delivery failed has an empty `callback_tx`, and re-sends after a failure appear in the gas file, not as extra triples rows). `resolve()` rows start from the Lasna tx itself. `last_activity_tx` = the gate's ack as seen back on Lasna |
| `core-dev-react-gas.csv` | every Lasna tx in which the guard emitted an event (a Cron tick or tx with no guard event has no row): branch, gas used, `CallbackRequest` logs it carries, whether it subscribed / unsubscribed the Cron watchdog, the latch cause if one fired, and every guard event in that tx (`rc_events`, e.g. `Retried`, `GateUnreachable`) |
| `core-dev-callback-failures.csv` | raw `CallbackFailure` logs on both callback proxies for this instance's gates (forced with `setFailNext`), with the selector and the epoch decoded from the payload |
| `core-dev-actions.csv` | every transaction the trigger script sent (chain, hash, local send time in ms) |

What the rows show, in order: a legitimate transfer (lock, then the mint of its nonce: two no-op rows); a forged mint
from the relayer key (one `react()` with two `CallbackRequest` logs → both gates paused, latched `REPEAT`); `seize` of the
proceeds, then the owner's `resolve()` (two resume callbacks); a mint sent before its lock (pause), then the real lock
(auto-resume in the same `react()` that saw it, no latch); a forged mint with both gates forced to fail (each proxy logs
`CallbackFailure`, the guard re-requests once per chain, the second failure ends in `GateUnreachable`, visible in `rc_events`; the gates
stayed open, which is the documented failure mode); then `seize` + `resolve()` again.

Live coverage stops there: the Cron watchdog was subscribed and unsubscribed live around every request (the
`cron_subscribe` / `cron_unsubscribe` columns), but its tick-driven re-request (a gate that stays silent with no
`CallbackFailure`) has not fired live; that path is covered by the Test Lib suite only.

## Instance `core-dev2` (core flow after QA fixes; same scripts, `INSTANCE=core-dev2`)

The same deployment and joiner as `core-dev`, from the later commit in `core-dev2-addresses.txt`. Files
`core-dev2-{addresses.txt,actions.csv,triples.csv,react-gas.csv,callback-failures.csv}` have the same columns. The run:
a legitimate transfer (two no-op rows), a forged mint (pause ×2 in one `react()`, latched `REPEAT`), `seize` + `resolve()`,
then a mint sent before its lock and the real lock (auto-resume). No forced failure on this instance, so its
callback-failures file has a header only.

## Instance `spike-dev` (gate G1 + day-1 probes; `scripts/spike-triples.ts`, `pnpm triples`)

Addresses in `spike-addresses.txt`. Its bytecode is the spike contract at the commit in that file's
`DEPLOYED_FROM_COMMIT=` line (a minimal one-route v0); later fixes to `src/` are not in that deployment.

| File | Rows |
|---|---|
| `triples.csv` | origin tx → Lasna react tx → gate callback tx, one row per callback (no-op rows have no callback) |
| `react-gas.csv` | gas used per `react()` branch, from Lasna receipts, and how many `CallbackRequest` logs each tx carries |
| `callback-failures.csv` | raw `CallbackFailure` logs on the Base Sepolia and Unichain Sepolia callback proxies for the spike gates |
| `skew-pairs.csv` | per lock/mint pair with the same key: origin and Lasna block timestamps, arrival order on Lasna (`order` labels the one pair whose mint was sent first on purpose) |
| `hop-probe.csv` | the Lasna self-callback requests (`HopRequested`; no `HopSeen` row = **no delivery observed** after 2 requests, so the self-callback path is unproven), and the Cron subscribe/unsubscribe done from inside `react()` |
| `spike-actions.csv` | every transaction the trigger script sent (chain, hash, local send time in ms) |

## Reading the timestamps

Block timestamps are whole seconds on every chain, and chain clocks are not synchronised to each other: a Lasna
timestamp can read *earlier* than the origin block that triggered it. Latency figures are therefore measured
off-chain by the observer; these rows prove the loop and its order, not fine-grained timing.

## Frozen deployment (P1c)
- `frozen-addresses.txt` (route A, route id 1), `route-b-addresses.txt` + `route-b-guard.txt` (route B, route id 2), `a0-addresses.txt` (unguarded control), `../deployments/testnet.json`.
- `frozen-bench-runs.csv`: one row per bench run (observer wall clock: this machine's `Date.now()` when a poll returned (poll every `poll_ms` plus RPC latency; no error bound is claimed), with whole-second block-timestamp deltas beside it as the on-chain cross-check; every run watches only blocks after the head captured before it started, and a forced run's resume-before-pause (poll jitter) leaves `pause_seconds` empty with the note `observer order inverted`; older rows predate the `recovery` column). `frozen-bench-summary.{json,md}` are generated from it by `scripts/bench-summary.ts` (never edited). `af-001` is a harness artifact (a smoke run had used its key, so the mint reverted `NonceUsed`); `af-061` replaces it. `bu-001..020` are the headline bursts, `bu-021..025` the guarded arm of the paired control. `frozen-burst-verify.csv` (`scripts/burst-verify.ts`, `pnpm burst:verify`, read-only) re-fetches each burst's stopping copycat and gate U `Paused` receipts and marks `reverted_after_pause` = 1 only when the copycat was mined as a revert strictly after the Paused tx (later block, or same block with a higher `transactionIndex`); `paused_event_ok` = 1 when the gate U receipt holds the gate's `Paused` event for the run's key; `reason` = `GatePaused` when an `eth_call` of the copycat's original input at its block returns revert selector `0x726461f5` (`unavailable` if the node refuses the historical state). Result: 25/25 rows after=1, paused_event_ok=1, reason=GatePaused. The summary's recovery distribution counts successful recoveries only (`recovery` = ok; older rows: both resumes observed).
- `a0-control-runs.csv`: the unguarded arm (`scripts/control.ts`; a fixed 6 copycats, so its issuance is illustrative).
- `frozen-routeb-runs.csv` + `g2-hyperlane.csv`: route B (Hyperlane warp route). The public relayer did not deliver, so deliveries are our own `Mailbox.process` (self-delivered). `lasna_order` is the on-chain order (block, then log index) of the two Lasna `Observed` logs, not which poll returned first (the committed bl-01..10 rows were stamped by poll order before this change; the script now writes the on-chain order). `frozen-routeb-blockts.csv` (`scripts/routeb-blockts.ts`, read-only) holds whole-second block timestamps of each drill's `fire()` tx and its gate Paused txs; the summary shows them beside the observer wall-clock deltas (fire() receipt seen to the poll that saw the gate event).
- `frozen-pause-audit.csv`: every `PauseRequested` the guard emitted, joined to the run that caused it (`scripts/pause-audit.ts`); the one `UNMATCHED` row is the pre-bench smoke attack.
- `frozen-triples.csv` / `frozen-react-gas.csv`: origin tx → Lasna react → gate callback joins from chain logs (`scripts/triples.ts`). Route B rows are joined to its gates from `route-b-guard.txt` (`GATE_B2`/`GATE_U2`); every gate and ack match keys on the route id.
- `frozen-heartbeat-runs.csv`: the 6-hourly liveness runs (`script/heartbeat.sh`).
- `frozen2-addresses.txt` + `frozen2-bench-runs.csv`: route A redeployed from the later reviewed source (contract at 30604c4). Its bench was stopped after 21 strict legit runs (all `ok`, 0 false pauses) when loop QA found two defects in the new saturation path (a `resolve()` sum that could overflow; a saturated source total that hid a SUPPLY deficit). Superseded by `frozen3`; the rows stay as recorded.

## Route A final deployment `frozen3` (headline numbers)
- `frozen3-addresses.txt`: route A (route id 1) redeployed from the final source (contract at e425c78, `src/Gate.sol:Gate`). Route B stays guarded by the `frozen` instance (its PausableIsms are owned by frozen's route B gates, and a Gate cannot hand ownership over), so each route has its own guard contract; `../deployments/testnet.json` lists both.
- `frozen3-bench-runs.csv`: the full bench re-run on frozen3 (same columns and harness as `frozen-bench-runs.csv`): 80 strict legit + 20 forced legit, 60 forged + 20 plausible attacks, `bu-001..020` headline bursts and `bu-021..025` the guarded arm of the paired control. `lf-019` has no `pause_seconds` (`observer order inverted`), and the summary names it.
- `frozen3-bench-summary.{json,md}` (`scripts/bench-summary.ts`, the default input), `frozen3-burst-verify.csv` (`scripts/burst-verify.ts`), `frozen3-pause-audit.csv` (`scripts/pause-audit.ts frozen3`), `frozen3-triples.csv` / `frozen3-react-gas.csv` / `frozen3-callback-failures.csv` (`scripts/triples.ts evidence/frozen3-addresses.txt`): all generated, never edited. The route B section of the frozen3 summary reads `frozen-routeb-runs.csv` (set `ROUTE_B_INSTANCE` to change it).
- `frozen3-heartbeat-runs.csv`: the 6-hourly liveness runs from now on (`script/heartbeat.sh` defaults to frozen3).

## Test run log
- `forge-test-2026-11-14.txt`: full `forge test` output on 2026-11-14 (ANSI colours stripped): 6 suites, 113 tests passed, 0 failed. Its last line is the one the landing page's terminal prints; timings are this machine's and vary per run.
