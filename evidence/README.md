# evidence/

Raw rows from live runs, regenerated from chain logs by `pnpm triples` (`scripts/spike-triples.ts`). Nothing here is
typed by hand except `spike-actions.csv`, which the trigger script appends as it sends each transaction.

Instance `spike-dev` is a **dev deployment** (addresses in `spike-addresses.txt`; gates are `ProbeGate`s with a
one-shot forced-failure flag). The deployment the final numbers cite comes later and is listed in `deployments/`.

| File | Rows |
|---|---|
| `triples.csv` | origin tx → Lasna react tx → gate callback tx, one row per callback (no-op rows have no callback); `last_activity_tx` = the gate's ack as seen back on Lasna |
| `react-gas.csv` | gas used per `react()` branch, from Lasna receipts, and how many `CallbackRequest` logs each tx carries |
| `callback-failures.csv` | raw `CallbackFailure` logs on the Base Sepolia and Unichain Sepolia callback proxies for our gates (forced with `ProbeGate.setFailNext`) |
| `skew-pairs.csv` | per lock/mint pair with the same key: origin and Lasna block timestamps, arrival order on Lasna (`order` labels the one pair whose mint was sent first on purpose) |
| `hop-probe.csv` | the Lasna self-callback request, and the Cron subscribe/unsubscribe done from inside `react()` |
| `spike-actions.csv` | every transaction the trigger script sent (chain, hash, local send time in ms) |

Block timestamps are whole seconds on every chain, and chain clocks are not synchronised to each other: a Lasna
timestamp can read one second *earlier* than the origin block that triggered it. Latency figures are therefore
measured off-chain later; these rows prove the loop and its order, not sub-second timing.
