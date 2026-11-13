// Ledgerlock bench: live runs on route A of one deployment, off-chain observer, one CSV row per run (appended as each
// run ends, so an interrupted bench resumes). Every number in the summary is computed from these rows (bench-summary.ts).
//   legit_strict   lock on Base, then (once mined) the matching mint on Unichain: no pause expected
//   legit_forced   forced fill-before-deposit: the mint lands first (key = next lock nonce), the lock follows 2-20 s later;
//                  both gates pause, then reopen by themselves; pause_seconds is the cost
//   attack_forged  a mint with a forged key (no lock): detection + pause latency, then seize + resolve()
//   attack_plausible  a mint at a key just above the lock nonce (no lock): the fail-closed case; recovery by seize + resolve
//   burst          forged mint, then one copycat per block until the first GatePaused revert (cap 30), then a forged
//                  release on Base (carry-home); exposure = (1 + landed) x 500 tUSD
// Usage: source ~/.config/reactive/testnet-deployer.env; tsx scripts/bench.ts <instance> <kind> <count> [firstIndex]
// Never prints a key. Clocks: Date.now() of this machine; polls every POLL_MS, so every timestamp carries +/- POLL_MS.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, defineChain, http, keccak256, parseAbi, toHex, type Hex, type Log } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAINS, client } from "../packages/reactive-kit/ts/chains.ts";

const [instance, kind, countArg, firstArg] = process.argv.slice(2);
if (!instance || !kind || !countArg) throw new Error("usage: bench.ts <instance> <kind> <count> [firstIndex]");
const COUNT = Number(countArg), FIRST = Number(firstArg ?? 1);
const LASNA = 5318007, BASE = 84532, UNI = 1301;
const POLL_MS = Number(process.env.POLL_MS ?? 400);
const A = Object.fromEntries(readFileSync(`evidence/${instance}-addresses.txt`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string])) as Record<string, Hex>;
const OUT = process.env.BENCH_OUT ?? `evidence/${instance}-bench-runs.csv`;
const COLS = ["run_id", "kind", "instance", "seq", "key", "amount_tusd", "recipient", "lock_tx", "mint_tx", "mint_sent_ms", "mint_mined_ms", "mint_block_ts",
  "lasna_seen_ms", "lasna_tx", "lasna_block_ts", "gate_u_seen_ms", "gate_u_tx", "gate_u_block_ts", "gate_b_seen_ms", "gate_b_tx", "gate_b_block_ts",
  "resume_u_seen_ms", "resume_b_seen_ms", "pause_seconds", "pause_epoch", "false_pause", "copycats_fired", "copycats_landed", "reverted_tx",
  "carry_home_tx", "carry_home_status", "exposure_tusd", "recovery_ms", "poll_ms", "outcome", "note"];

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex, { nonceManager });
const mk = (id: number) => createWalletClient({
  account,
  chain: defineChain({ id, name: CHAINS[id].name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc] } } }),
  transport: http(process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc, { retryCount: 3, retryDelay: 400 }),
});
const wallet = { [LASNA]: mk(LASNA), [BASE]: mk(BASE), [UNI]: mk(UNI) } as Record<number, ReturnType<typeof mk>>;

const lockboxAbi = parseAbi(["function lock(address,uint256) returns (uint64)", "function nonce() view returns (uint64)", "function collateral() view returns (uint256)",
  "function releaseByRelayer(uint64,address,uint256)", "event Locked(uint64 indexed nonce, address indexed to, uint256 amount)"]);
const minterAbi = parseAbi(["function mint(uint64,address,uint256)", "function seize(address,uint256)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const rcAbi = parseAbi(["function resolve(uint256,uint8,bool)", "function routeState(uint256) view returns (bool,bool,bool,uint64,uint32,uint256,uint256)",
  "event Observed(uint256 indexed routeId, uint8 side, uint256 key, bytes32 indexed originTx)",
  "event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event ResumeRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event IncidentLatched(uint256 indexed routeId, uint8 cause, uint64 epoch)"]);
const gateAbi = parseAbi(["function isOpen() view returns (bool)",
  "event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)"]);
const E = (abi: ReturnType<typeof parseAbi>, name: string) => abi.find((x) => x.type === "event" && x.name === name) as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const h = (s: string): Hex => keccak256(toHex(s));
const addrOf = (s: string): Hex => `0x${h(s).slice(26)}` as Hex;
const ROUTE = 1n, E18 = 10n ** 18n;
const FIXED_GAS = 400_000n;

type Hit = { at: number; tx: Hex; block: bigint; epoch?: bigint; args?: Record<string, unknown> };
/** Poll one chain for the first log matching `match`, starting at `from`. */
async function watch(chainId: number, address: Hex, event: unknown, from: bigint, match: (l: Log & { args?: Record<string, unknown> }) => boolean, timeoutMs: number): Promise<Hit | null> {
  const c = client(chainId), end = Date.now() + timeoutMs;
  let f = from;
  while (Date.now() < end) {
    try {
      const head = await c.getBlockNumber();
      if (head >= f) {
        const logs = (await c.getLogs({ address, event: event as never, fromBlock: f, toBlock: head })) as (Log & { args?: Record<string, unknown> })[];
        const hit = logs.find(match);
        if (hit) return { at: Date.now(), tx: hit.transactionHash as Hex, block: hit.blockNumber as bigint, args: hit.args };
        f = head + 1n;
      }
    } catch { /* transient RPC error: retry */ }
    await sleep(POLL_MS);
  }
  return null;
}
const blockTs = async (chainId: number, b?: bigint) => (b === undefined ? "" : String(Number((await client(chainId).getBlock({ blockNumber: b })).timestamp)));
const heads = async () => ({ lasna: await client(LASNA).getBlockNumber(), base: await client(BASE).getBlockNumber(), uni: await client(UNI).getBlockNumber() });

async function send(chainId: number, to: Hex, abi: unknown, fn: string, args: unknown[], gas = FIXED_GAS): Promise<{ tx: Hex; sentAt: number; minedAt: number; block: bigint; status: string }> {
  const sentAt = Date.now();
  const extra = chainId === LASNA ? { type: "legacy" as const, gasPrice: 100_000_000_000n } : {};
  const tx = await wallet[chainId].writeContract({ address: to, abi: abi as never, functionName: fn as never, args: args as never, gas, ...extra } as never);
  const r = await client(chainId).waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
  return { tx, sentAt, minedAt: Date.now(), block: r.blockNumber, status: r.status };
}
const routeState = async () => {
  const s = await client(LASNA).readContract({ address: A.RC, abi: rcAbi, functionName: "routeState", args: [ROUTE] }) as readonly [boolean, boolean, boolean, bigint, number, bigint, bigint];
  return { paused: s[0], incident: s[1], epoch: s[3], pending: s[4], unbacked: s[5], unbackedRel: s[6] };
};
const gatesOpen = async () => (await client(BASE).readContract({ address: A.GATE_B, abi: gateAbi, functionName: "isOpen" })) as boolean &&
  ((await client(UNI).readContract({ address: A.GATE_U, abi: gateAbi, functionName: "isOpen" })) as boolean);

/** Bring a paused/latched route back: seize every holder in `holders`, wait for the guard to have booked everything, resolve(), wait for both gates to reopen. */
async function recover(holders: Hex[], from: Awaited<ReturnType<typeof heads>>): Promise<{ resumeU: Hit | null; resumeB: Hit | null; ms: number; note: string }> {
  const t0 = Date.now();
  let note = "";
  for (const hd of holders) {
    const bal = (await client(UNI).readContract({ address: A.MINTER, abi: minterAbi, functionName: "balanceOf", args: [hd] })) as bigint;
    if (bal > 0n) await send(UNI, A.MINTER, minterAbi, "seize", [hd, bal]);
  }
  const pre = await heads();
  let resolveTx: Hex | null = null;
  for (let i = 0; i < 40 && !resolveTx; i++) {
    const st = await routeState();
    if (st.unbacked === 0n && st.unbackedRel === 0n) {
      try { resolveTx = (await send(LASNA, A.RC, rcAbi, "resolve", [ROUTE, 1, false], 3_000_000n)).tx; } catch (e) { note += `resolve retry ${i}: ${String(e).slice(0, 60)}; `; }
    }
    if (!resolveTx) await sleep(3000);
  }
  if (!resolveTx) return { resumeU: null, resumeB: null, ms: Date.now() - t0, note: note + "resolve failed" };
  const [ru, rb] = await Promise.all([
    watch(UNI, A.GATE_U, E(gateAbi, "Resumed"), pre.uni, () => true, 120_000),
    watch(BASE, A.GATE_B, E(gateAbi, "Resumed"), pre.base, () => true, 120_000),
  ]);
  void from;
  return { resumeU: ru, resumeB: rb, ms: Date.now() - t0, note };
}

const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").slice(1).map((l) => l.split(",")[0]) : []);
if (!existsSync(OUT)) writeFileSync(OUT, COLS.join(",") + "\n");
function emit(row: Record<string, unknown>) {
  const full = { instance, poll_ms: POLL_MS, ...row } as Record<string, unknown>;
  appendFileSync(OUT, COLS.map((c) => String(full[c] ?? "").replaceAll(",", ";")).join(",") + "\n");
  console.log(`${full.run_id} ${full.outcome} ${full.note ?? ""}`.trim());
}
const AMOUNTS = [25n, 40n, 100n, 250n, 500n];
const prefix = { legit_strict: "ls", legit_forced: "lf", attack_forged: "af", attack_plausible: "ap", burst: "bu" }[kind];
if (!prefix) throw new Error(`unknown kind ${kind}`);

for (let i = FIRST; i < FIRST + COUNT; i++) {
  const runId = `${prefix}-${String(i).padStart(3, "0")}`;
  if (done.has(runId)) continue;
  // The route must be clean before a run starts; if a previous run left it paused, clear it (and say so).
  let note = "";
  const st0 = await routeState();
  if (st0.paused || st0.incident || !(await gatesOpen())) {
    const r = await recover([addrOf(`attacker-leftover`)], await heads());
    note += `route was not clean at start (paused=${st0.paused} incident=${st0.incident}); cleared by resolve in ${r.ms} ms; `;
  }
  const amount = (kind.startsWith("legit") ? AMOUNTS[i % AMOUNTS.length] : 500n) * E18;
  const user = addrOf(`ledgerlock-user-${i % 4}`), attacker = addrOf(`ledgerlock-attacker-${runId}`);
  const row: Record<string, unknown> = { run_id: runId, kind, seq: i, amount_tusd: amount / E18, outcome: "ok" };
  const hd0 = await heads();
  try {
    if (kind === "legit_strict") {
      const lk = await send(BASE, A.LOCKBOX, lockboxAbi, "lock", [user, amount]);
      const nonce = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce", blockNumber: lk.block }) as bigint);
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [nonce, user, amount]);
      Object.assign(row, { key: nonce, recipient: user, lock_tx: lk.tx, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mint.minedAt });
      // the guard must book the mint (Observed MINT, side 1) and must not have paused
      const seen = await watch(LASNA, A.RC, E(rcAbi, "Observed"), hd0.lasna, (l) => l.args?.originTx === mint.tx, 90_000);
      const paused = (await client(LASNA).getLogs({ address: A.RC, event: E(rcAbi, "PauseRequested"), fromBlock: hd0.lasna, toBlock: "latest" })).length > 0;
      Object.assign(row, { lasna_seen_ms: seen?.at, lasna_tx: seen?.tx, false_pause: paused ? 1 : 0, outcome: seen ? (paused ? "false_pause" : "ok") : "timeout" });
      if (paused) {
        const r = await recover([], hd0);
        Object.assign(row, { gate_u_seen_ms: "", resume_u_seen_ms: r.resumeU?.at, resume_b_seen_ms: r.resumeB?.at, recovery_ms: r.ms });
      }
    } else if (kind === "legit_forced") {
      const nonce = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce" }) as bigint) + 1n;
      const delayMs = (2 + (i * 7) % 19) * 1000; // 2..20 s, deterministic from the run index
      const wU = watch(UNI, A.GATE_U, E(gateAbi, "Paused"), hd0.uni, () => true, 90_000);
      const wB = watch(BASE, A.GATE_B, E(gateAbi, "Paused"), hd0.base, () => true, 90_000);
      const wL = watch(LASNA, A.RC, E(rcAbi, "PauseRequested"), hd0.lasna, () => true, 90_000);
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [nonce, user, amount]);
      await sleep(delayMs);
      const lk = await send(BASE, A.LOCKBOX, lockboxAbi, "lock", [user, amount]);
      const [pu, pb, pl] = await Promise.all([wU, wB, wL]);
      const rU = watch(UNI, A.GATE_U, E(gateAbi, "Resumed"), hd0.uni, () => true, 120_000);
      const rB = watch(BASE, A.GATE_B, E(gateAbi, "Resumed"), hd0.base, () => true, 120_000);
      const [ru, rb] = await Promise.all([rU, rB]);
      Object.assign(row, { key: nonce, recipient: user, lock_tx: lk.tx, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mint.minedAt,
        lasna_seen_ms: pl?.at, lasna_tx: pl?.tx, gate_u_seen_ms: pu?.at, gate_u_tx: pu?.tx, gate_b_seen_ms: pb?.at, gate_b_tx: pb?.tx,
        resume_u_seen_ms: ru?.at, resume_b_seen_ms: rb?.at, pause_seconds: pu && ru ? ((ru.at - pu.at) / 1000).toFixed(1) : "",
        false_pause: 1, note: `forced fill-before-deposit; lock sent ${delayMs} ms after the mint`, outcome: pu && ru ? "ok" : "timeout" });
      if (!(pu && ru)) note += "forced run did not complete; ";
    } else {
      // attack kinds: key forged (beyond highest lock + K) or plausible (just above the lock nonce)
      const lockNonce = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce" }) as bigint);
      const key = kind === "attack_plausible" ? lockNonce + 3n : 1_000_000n + BigInt(i) * 1000n + (kind === "burst" ? 500_000n : 0n);
      const watchers = () => [
        watch(LASNA, A.RC, E(rcAbi, "PauseRequested"), hd0.lasna, (l) => l.args?.key === key, 120_000),
        watch(UNI, A.GATE_U, E(gateAbi, "Paused"), hd0.uni, (l) => l.args?.key === key, 120_000),
        watch(BASE, A.GATE_B, E(gateAbi, "Paused"), hd0.base, (l) => l.args?.key === key, 120_000),
      ];
      const ws = watchers();
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [key, attacker, amount]);
      let fired = 0, landed = 0, reverted = "", carryTx = "", carryStatus = "";
      if (kind === "burst") {
        for (let c = 1; c <= 30; c++) {
          fired = c;
          const cp = await send(UNI, A.MINTER, minterAbi, "mint", [key + BigInt(c), attacker, amount], 300_000n).catch((e) => ({ status: "error", tx: "" as Hex, err: String(e) }));
          if (cp.status === "success") landed++; else { reverted = cp.tx; break; }
        }
        const rel = await send(BASE, A.LOCKBOX, lockboxAbi, "releaseByRelayer", [key + 1000n, attacker, amount], 300_000n).catch((e) => ({ status: `error:${String(e).slice(0, 40)}`, tx: "" as Hex }));
        carryTx = rel.tx; carryStatus = rel.status;
      }
      const [pl, pu, pb] = await Promise.all(ws);
      const mined = mint.minedAt;
      Object.assign(row, { key, recipient: attacker, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mined, mint_block_ts: await blockTs(UNI, mint.block),
        lasna_seen_ms: pl?.at, lasna_tx: pl?.tx, lasna_block_ts: await blockTs(LASNA, pl?.block),
        gate_u_seen_ms: pu?.at, gate_u_tx: pu?.tx, gate_u_block_ts: await blockTs(UNI, pu?.block),
        gate_b_seen_ms: pb?.at, gate_b_tx: pb?.tx, gate_b_block_ts: await blockTs(BASE, pb?.block),
        pause_epoch: pl?.args?.epoch, copycats_fired: kind === "burst" ? fired : "", copycats_landed: kind === "burst" ? landed : "", reverted_tx: reverted,
        carry_home_tx: carryTx, carry_home_status: carryStatus, exposure_tusd: kind === "burst" ? (1 + landed) * 500 : 500,
        outcome: pl && pu && pb ? (kind === "burst" && !reverted ? "censored" : "ok") : "timeout" });
      const r = await recover([attacker], hd0);
      Object.assign(row, { resume_u_seen_ms: r.resumeU?.at, resume_b_seen_ms: r.resumeB?.at, recovery_ms: r.ms });
      note += r.note;
      if (kind === "attack_plausible") { // advance the lock nonce past the consumed key so later legit transfers get clean nonces
        let n = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce" }) as bigint);
        while (n < key) { await send(BASE, A.LOCKBOX, lockboxAbi, "lock", [addrOf("ledgerlock-nonce-advance"), 1n]); n++; }
      }
    }
  } catch (e) {
    row.outcome = "error"; note += String(e).slice(0, 120);
  }
  row.note = [row.note, note].filter(Boolean).join("; ");
  emit(row);
}
