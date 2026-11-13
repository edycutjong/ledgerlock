# reactive-kit

> **Provenance:** copied unchanged from the same author's Heirloom repo (`packages/reactive-kit/`), written during the Reactive Omni Buildathon (Nov 2026), MIT. Ledgerlock vendors it rather than importing across repos; Ledgerlock-specific code lives in `src/`.

Small, MIT-licensed building blocks for **Reactive Network Omni** projects (`reactive-lib-omni`), written for Heirloom
and meant to be copied into other repos as-is (keep this README and `LICENSE` with it).

## Solidity (`src/`)

| File | What it is |
|---|---|
| `test/OmniReactiveTest.sol` + `test/OmniSystemMock.sol` | Foundry harness for Omni contracts: origin event → `react()` from `0x8888…8888` → `requestCallbackV_1_0` → callback through reactive-test-lib's `MockCallbackProxy` → destination events fed back (Ack loops) until quiescence. Real CRON topics. Wildcard subscription semantics (chain 0 / contract 0 / `REACTIVE_IGNORE`). |
| `CronTopics.sol` | The network's CRON topic0 values, the legacy emitter `0x…fffFfF`, `isCron()`. |
| `AbsenceWatch.sol` | Expected-event + timeout state (owner silence, stale oracle canary). Timestamps only; `arm` resets `lastAt`. |
| `AckLedger.sol` | One in-flight callback: Ack-or-resend after a full `ackTimeout`, then a slow pace and a single alarm. |
| `CallbackFailureWatch.sol` | Decodes the destination proxy's `CallbackFailure(address indexed target, bytes payload)`. |

### Why the harness adapter exists

`reactive-test-lib` (pinned `2ff9b2a`) targets the legacy library: its mock system contract lives at `0x…fffFfF`, it
calls `react()` from that address, it collects callbacks from the legacy `Callback` event, and it injects the
deployer as the callback's first argument. Omni contracts accept `react()` only from `0x8888…8888`, request callbacks
through `SYSTEM.requestCallbackV_1_0`, and — measured on Lasna → Base Sepolia — receive the **requesting reactive
contract's** address as the injected first argument. Its CRON constants are also placeholders that differ from the
network's topics. So the kit keeps the Test Lib for `MockCallbackProxy` and its result types, and replaces the
simulator loop with an Omni one.

```solidity
contract MyTest is OmniReactiveTest {
    function setUp() public override {
        super.setUp();               // etches OmniSystemMock at 0x8888…8888, deploys MockCallbackProxy
        onChain(address(token), 84532);
        // deploy your RC and your AbstractCallback(proxy, rc) destination…
    }
    function test_loop() public {
        CallbackResult[] memory r = cycle(owner, address(token), abi.encodeCall(Token.transfer, (to, 1)));
        assertCallbacks(r, 1);
        assertAllSucceeded(r);
    }
}
```

## TypeScript (`ts/`, viem + tsx)

| File | What it is |
|---|---|
| `chains.ts` | Chain registry (RPC from env, callback proxies, explorers, per-RPC `eth_getLogs` span), `assertSameNetworkClass`. |
| `triples.ts` | Tx-triple logger: origin/CRON tx → reactive tx → callback tx with on-chain timestamps; append-only CSV, first row per key wins. Joins on data the contracts emit (origin tx hash + seq), so it needs only `eth_getLogs`. |
| `latency.ts` | Wall-clock observer: local send → mined → reactive log seen → callback log seen; nearest-rank percentiles. |
| `trigger.ts` | `trigger()` convention for origin scripts: key from env only, wall-clock times, one row in `evidence/origins.csv`. |

Block timestamps are 1 s resolution and are not synchronised across chains (Day-1 rows show a Lasna block stamped one
second *before* its Base Sepolia origin), so hop latencies come from the wall-clock observer, not from timestamp deltas.

## Tests

```sh
FOUNDRY_PROFILE=kit forge test     # Solidity
pnpm test:ts                       # TypeScript
```
