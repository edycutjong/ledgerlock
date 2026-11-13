# evidence/

Raw rows from live runs on Reactive Lasna + Base Sepolia + Unichain Sepolia, regenerated from chain logs. Nothing here is
typed by hand except `core-dev-actions.csv` and `spike-actions.csv`, which the trigger scripts append as they send each transaction.

Both instances below are **dev deployments**: their gates are `ProbeGate`s (a `Gate` plus a forced-failure flag the
guardian can set). The deployment the final numbers cite comes later and is listed in `deployments/`.

## Instance `core-dev` (core flow; `scripts/triples.ts`, `pnpm triples:core`)

Addresses, start blocks and the source commit (`COMMIT=`) are in `core-dev-addresses.txt`; deployed by
`script/core-deploy.sh`, driven by `script/core-trigger.sh`. The deployed bytecode is `src/` at that commit; later
fixes in `src/` are covered by the Test Lib suite and reach the chain with the next deployment, not this one.

| File | Rows |
|---|---|
| `core-dev-triples.csv` | origin tx → Lasna `react()` tx → gate callback tx, one row per callback leg (no-op rows have no callback). `resolve()` rows start from the Lasna tx itself. `last_activity_tx` = the gate's ack as seen back on Lasna |
| `core-dev-react-gas.csv` | every Lasna tx of the instance: branch, gas used, `CallbackRequest` logs it carries, whether it subscribed / unsubscribed the Cron watchdog, the latch cause if one fired, and every guard event in that tx (`rc_events`, e.g. `Retried`, `GateUnreachable`) |
| `core-dev-callback-failures.csv` | raw `CallbackFailure` logs on both callback proxies for this instance's gates (forced with `setFailNext`), with the selector and the epoch decoded from the payload |
| `core-dev-actions.csv` | every transaction the trigger script sent (chain, hash, local send time in ms) |

What the rows show, in order: a legitimate transfer (lock, then the mint of its nonce: two no-op rows); a forged mint
from the relayer key (one `react()` with two `CallbackRequest` logs → both gates paused, latched `REPEAT`); `seize` of the
proceeds, then the owner's `resolve()` (two resume callbacks); a mint sent before its lock (pause), then the real lock
(auto-resume in the same `react()` that saw it, no latch); a forged mint with both gates forced to fail (each proxy logs
`CallbackFailure`, the guard re-requests once per chain, the second failure ends in `GateUnreachable`, visible in `rc_events`; the gates
stayed open, which is the documented failure mode); then `seize` + `resolve()` again.

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
