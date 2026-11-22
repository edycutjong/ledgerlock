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
// Never prints a key. Clocks: every *_ms value is this machine's Date.now() when a poll returned. The poll interval is POLL_MS (default 400)
// plus RPC latency, so it is not a bound on the error; block-timestamp deltas (whole seconds) are recorded beside them as the on-chain cross-check.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, defineChain, http, keccak256, parseAbi, parseEventLogs, toHex, type Hex, type Log } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAINS, client } from "../packages/reactive-kit/ts/chains.ts";
import { getLogsChunked } from "../packages/reactive-kit/ts/triples.ts";

const [instance, kind, countArg, firstArg] = process.argv.slice(2);
if (!instance || !kind || !countArg) throw new Error("usage: bench.ts <instance> <kind> <count> [firstIndex]");
const COUNT = Number(countArg), FIRST = Number(firstArg ?? 1);
const LASNA = 5318007, BASE = 84532, UNI = 1301;
const POLL_MS = Number(process.env.POLL_MS ?? 400);
// VERBOSE=1 prints each leg of the loop as the observer sees it, stamped against t0 = the moment the run's mint receipt
// returned (the same clock as the CSV columns). Display only: the CSV row is computed exactly as without it.
const VERBOSE = process.env.VERBOSE === "1";
const say = (s: string) => { if (VERBOSE) console.log(s); };
const T0 = { at: 0 };
const rel = (at: number) => `+${((at - T0.at) / 1000).toFixed(3)} s`;
const A = Object.fromEntries(readFileSync(`evidence/${instance}-addresses.txt`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string])) as Record<string, Hex>;
const OUT = process.env.BENCH_OUT ?? `evidence/${instance}-bench-runs.csv`;
const COLS = ["run_id", "kind", "instance", "seq", "key", "amount_tusd", "recipient", "lock_tx", "mint_tx", "mint_sent_ms", "mint_mined_ms", "mint_block_ts",
  "lasna_seen_ms", "lasna_tx", "lasna_block_ts", "gate_u_seen_ms", "gate_u_tx", "gate_u_block_ts", "gate_b_seen_ms", "gate_b_tx", "gate_b_block_ts",
  "resume_u_seen_ms", "resume_b_seen_ms", "pause_seconds", "pause_epoch", "false_pause", "copycats_fired", "copycats_landed", "reverted_tx",
  "carry_home_tx", "carry_home_status", "exposure_tusd", "recovery_ms", "poll_ms", "outcome", "note", "recovery"];

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
/** Poll one chain for the first log matching `match`, starting at `from`; each request spans at most the chain's logSpan blocks. */
async function watch(chainId: number, address: Hex, event: unknown, from: bigint, match: (l: Log & { args?: Record<string, unknown> }) => boolean, timeoutMs: number): Promise<Hit | null> {
  const c = client(chainId), span = CHAINS[chainId].logSpan, end = Date.now() + timeoutMs;
  let f = from, errs = 0;
  while (Date.now() < end) {
    try {
      const head = await c.getBlockNumber();
      while (f <= head && Date.now() < end) {
        const to = head < f + span - 1n ? head : f + span - 1n;
        const logs = (await c.getLogs({ address, event: event as never, fromBlock: f, toBlock: to })) as (Log & { args?: Record<string, unknown> })[];
        const hit = logs.find(match);
        if (hit) return { at: Date.now(), tx: hit.transactionHash as Hex, block: hit.blockNumber as bigint, args: hit.args };
        f = to + 1n;
      }
      errs = 0;
    } catch (e) { if (++errs === 5) console.error(`watch ${CHAINS[chainId].name} ${address}: 5 errors in a row, still trying: ${String(e).slice(0, 160)}`); }
    await sleep(POLL_MS);
  }
  return null;
}
const blockTs = async (chainId: number, b?: bigint) => (b === undefined ? "" : String(Number((await client(chainId).getBlock({ blockNumber: b })).timestamp)));
const heads = async () => ({ lasna: await client(LASNA).getBlockNumber(), base: await client(BASE).getBlockNumber(), uni: await client(UNI).getBlockNumber() });

async function send(chainId: number, to: Hex, abi: unknown, fn: string, args: unknown[], gas = FIXED_GAS): Promise<{ tx: Hex; sentAt: number; minedAt: number; block: bigint; status: string; logs: Log[] }> {
  const sentAt = Date.now();
  const extra = chainId === LASNA ? { type: "legacy" as const, gasPrice: 100_000_000_000n } : {};
  const tx = await wallet[chainId].writeContract({ address: to, abi: abi as never, functionName: fn as never, args: args as never, gas, ...extra } as never);
  const r = await client(chainId).waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
  return { tx, sentAt, minedAt: Date.now(), block: r.blockNumber, status: r.status, logs: r.logs as Log[] };
}
const routeState = async () => {
  const s = await client(LASNA).readContract({ address: A.RC, abi: rcAbi, functionName: "routeState", args: [ROUTE] }) as readonly [boolean, boolean, boolean, bigint, number, bigint, bigint];
  return { paused: s[0], incident: s[1], epoch: s[3], pending: s[4], unbacked: s[5], unbackedRel: s[6] };
};
const gatesOpen = async () => (await client(BASE).readContract({ address: A.GATE_B, abi: gateAbi, functionName: "isOpen" })) as boolean &&
  ((await client(UNI).readContract({ address: A.GATE_U, abi: gateAbi, functionName: "isOpen" })) as boolean);

/** Bring a paused/latched route back: seize every holder in `holders`, wait for the guard to have booked everything, resolve(), wait for both gates to reopen. */
async function recover(holders: Hex[], from: Awaited<ReturnType<typeof heads>>, minEpoch = 0n): Promise<{ resumeU: Hit | null; resumeB: Hit | null; ms: number; note: string; ok: boolean }> {
  const t0 = Date.now();
  let note = "";
  for (const hd of holders) {
    const bal = (await client(UNI).readContract({ address: A.MINTER, abi: minterAbi, functionName: "balanceOf", args: [hd] })) as bigint;
    if (bal > 0n) { const sz = await send(UNI, A.MINTER, minterAbi, "seize", [hd, bal]); say(`recovery: seize ${bal / E18} tUSD from the attacker on Unichain  tx ${sz.tx}`); }
  }
  const pre = await heads();
  let resolveTx: Hex | null = null;
  for (let i = 0; i < 40 && !resolveTx; i++) {
    const st = await routeState();
    if (st.unbacked === 0n && st.unbackedRel === 0n) {
      try {
        const r = await send(LASNA, A.RC, rcAbi, "resolve", [ROUTE, 1, false], 3_000_000n);
        if (r.status === "success") { resolveTx = r.tx; say(`recovery: owner resolve() on Lasna  tx ${r.tx}`); } else note += `resolve retry ${i}: receipt ${r.status}; `;
      } catch (e) { note += `resolve retry ${i}: ${String(e).slice(0, 60)}; `; }
    }
    if (!resolveTx) await sleep(3000);
  }
  if (!resolveTx) return { resumeU: null, resumeB: null, ms: Date.now() - t0, note: note + "resolve failed", ok: false };
  const [ru, rb] = await Promise.all([
    watch(UNI, A.GATE_U, E(gateAbi, "Resumed"), pre.uni + 1n, (l) => ((l.args?.epoch as bigint | undefined) ?? 0n) > minEpoch, 120_000),
    watch(BASE, A.GATE_B, E(gateAbi, "Resumed"), pre.base + 1n, (l) => ((l.args?.epoch as bigint | undefined) ?? 0n) > minEpoch, 120_000),
  ]);
  void from;
  say(ru && rb ? `recovery: gate U Resumed · gate B Resumed  ${((Date.now() - t0) / 1000).toFixed(1)} s after recovery began` : "recovery: a gate did not reopen (timeout)");
  return { resumeU: ru, resumeB: rb, ms: Date.now() - t0, note, ok: !!(ru && rb) };
}

if (existsSync(OUT)) {
  const hdr = readFileSync(OUT, "utf8").split("\n")[0];
  if (hdr !== COLS.join(",")) throw new Error(`${OUT} has a different header than this script's COLS (an older column set); refusing to append misaligned rows. Write to a new BENCH_OUT or migrate the file.`);
}
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").slice(1).map((l) => l.split(",")[0]) : []);
if (!existsSync(OUT)) writeFileSync(OUT, COLS.join(",") + "\n");
function emit(row: Record<string, unknown>) {
  const full = { instance, poll_ms: POLL_MS, ...row } as Record<string, unknown>;
  appendFileSync(OUT, COLS.map((c) => String(full[c] ?? "").replaceAll(",", ";").replaceAll('"', "'").replaceAll("\n", " ")).join(",") + "\n");
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
  let recovery = "";
  const markRec = (ok: boolean) => { recovery = recovery === "failed" || !ok ? "failed" : "ok"; };
  const st0 = await routeState();
  if (st0.paused || st0.incident || !(await gatesOpen())) {
    const r = await recover([addrOf(`attacker-leftover`)], await heads());
    markRec(r.ok);
    if (!r.ok) { emit({ run_id: runId, kind, seq: i, amount_tusd: "", outcome: "error", note: "route not clean at start; cleanup failed; " + r.note, recovery: "failed" }); continue; }
    note += `route was not clean at start (paused=${st0.paused} incident=${st0.incident}); cleared by resolve in ${r.ms} ms; `;
  }
  const amount = (kind.startsWith("legit") ? AMOUNTS[i % AMOUNTS.length] : 500n) * E18;
  const user = addrOf(`ledgerlock-user-${i % 4}`), attacker = addrOf(`ledgerlock-attacker-${runId}`);
  const row: Record<string, unknown> = { run_id: runId, kind, seq: i, amount_tusd: amount / E18, outcome: "ok" };
  const hd0 = await heads();
  say(`run ${runId} · ${kind} · ${instance} · route A clean, both gates open`);
  try {
    if (kind === "legit_strict") {
      const lk = await send(BASE, A.LOCKBOX, lockboxAbi, "lock", [user, amount]);
      // the key comes from the Locked event of OUR lock receipt (another lock in the same block would make nonce() at that block wrong)
      const locked = parseEventLogs({ abi: lockboxAbi, eventName: "Locked", logs: lk.logs as never }).find((l) => l.address.toLowerCase() === A.LOCKBOX.toLowerCase() && l.args.to?.toLowerCase() === user.toLowerCase());
      if (!locked) throw new Error("no Locked event in the lock receipt");
      const nonce = locked.args.nonce as bigint;
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [nonce, user, amount]);
      Object.assign(row, { key: nonce, recipient: user, lock_tx: lk.tx, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mint.minedAt });
      // the guard must book the mint (Observed MINT, side 1) and must not have paused
      const seen = await watch(LASNA, A.RC, E(rcAbi, "Observed"), hd0.lasna + 1n, (l) => l.args?.originTx === mint.tx, 90_000);
      // count only PauseRequested for route A (a guard contract can carry more than one route; route B has its own guard today)
      const paused = (await getLogsChunked(LASNA, { address: A.RC, event: E(rcAbi, "PauseRequested"), fromBlock: hd0.lasna + 1n, args: { routeId: ROUTE } })).length > 0;
      Object.assign(row, { lasna_seen_ms: seen?.at, lasna_tx: seen?.tx, false_pause: paused ? 1 : 0, outcome: seen ? (paused ? "false_pause" : "ok") : "timeout" });
      if (paused) {
        const r = await recover([], hd0);
        markRec(r.ok);
        Object.assign(row, { gate_u_seen_ms: "", resume_u_seen_ms: r.resumeU?.at, resume_b_seen_ms: r.resumeB?.at, recovery_ms: r.ms });
      }
    } else if (kind === "legit_forced") {
      const nonce = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce" }) as bigint) + 1n;
      const delayMs = (2 + (i * 7) % 19) * 1000; // 2..20 s, deterministic from the run index
      const isKey = (l: { args?: Record<string, unknown> }) => l.args?.key === nonce; // events of this run only (the auto-resume carries the lock's key = nonce)
      const wU = watch(UNI, A.GATE_U, E(gateAbi, "Paused"), hd0.uni + 1n, isKey, 90_000);
      const wB = watch(BASE, A.GATE_B, E(gateAbi, "Paused"), hd0.base + 1n, isKey, 90_000);
      const wL = watch(LASNA, A.RC, E(rcAbi, "PauseRequested"), hd0.lasna + 1n, isKey, 90_000);
      // the Resumed watchers start with the Paused ones, so a resume landing while a pause leg is still polled is not stamped late
      const rU = watch(UNI, A.GATE_U, E(gateAbi, "Resumed"), hd0.uni + 1n, isKey, 150_000);
      const rB = watch(BASE, A.GATE_B, E(gateAbi, "Resumed"), hd0.base + 1n, isKey, 150_000);
      let mintSeen!: () => void;
      const minted = new Promise<void>((r) => { mintSeen = r; });
      if (VERBOSE) [[wL, "Lasna  PauseRequested (no lock seen yet)"], [wU, "gate U Paused (Unichain)"], [wB, "gate B Paused (Base)"],
        [rU, "gate U Resumed by itself (lock matched)"], [rB, "gate B Resumed by itself (lock matched)"]].forEach(([w, name]) =>
        void (w as Promise<Hit | null>).then(async (hit) => { await minted; say(hit ? `${name}  ${rel(hit.at)}  tx ${hit.tx}` : `${name}: not seen (timeout)`); }));
      say(`legit transfer sent OUT OF ORDER on purpose: mint key ${nonce} first, its lock ${delayMs / 1000} s later`);
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [nonce, user, amount]);
      T0.at = mint.minedAt; mintSeen();
      say(`mint mined on Unichain, ${amount / E18} tUSD, lock not sent yet  tx ${mint.tx}  (t0)`);
      await sleep(delayMs);
      const lk = await send(BASE, A.LOCKBOX, lockboxAbi, "lock", [user, amount]);
      say(`lock mined on Base  ${rel(lk.minedAt)}  tx ${lk.tx}`);
      const [pu, pb, pl, ru, rb] = await Promise.all([wU, wB, wL, rU, rB]);
      const all4 = !!(pu && pb && ru && rb);
      // a resume observed before its pause on the same gate is poll jitter: no duration, never a negative one
      const inverted = all4 && (ru!.at < pu!.at || rb!.at < pb!.at);
      Object.assign(row, { key: nonce, recipient: user, lock_tx: lk.tx, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mint.minedAt,
        lasna_seen_ms: pl?.at, lasna_tx: pl?.tx, gate_u_seen_ms: pu?.at, gate_u_tx: pu?.tx, gate_b_seen_ms: pb?.at, gate_b_tx: pb?.tx,
        resume_u_seen_ms: ru?.at, resume_b_seen_ms: rb?.at, pause_seconds: all4 && !inverted ? (Math.max(ru!.at - pu!.at, rb!.at - pb!.at) / 1000).toFixed(1) : "",
        false_pause: 1, note: `forced fill-before-deposit; lock sent ${delayMs} ms after the mint`, outcome: all4 ? "ok" : "timeout" });
      if (!all4) note += "forced run did not complete; ";
      if (inverted) note += "observer order inverted; ";
      if (all4 && !inverted) say(`false-pause cost: ${row.pause_seconds} s shut, reopened with no human action`);
    } else {
      // attack kinds: key forged (beyond highest lock + K) or plausible (just above the lock nonce)
      const lockNonce = BigInt(await client(BASE).readContract({ address: A.LOCKBOX, abi: lockboxAbi, functionName: "nonce" }) as bigint);
      const key = kind === "attack_plausible" ? lockNonce + 3n : 1_000_000n + BigInt(i) * 1000n + (kind === "burst" ? 500_000n : 0n);
      const watchers = () => [
        watch(LASNA, A.RC, E(rcAbi, "PauseRequested"), hd0.lasna + 1n, (l) => l.args?.key === key, 120_000),
        watch(UNI, A.GATE_U, E(gateAbi, "Paused"), hd0.uni + 1n, (l) => l.args?.key === key, 120_000),
        watch(BASE, A.GATE_B, E(gateAbi, "Paused"), hd0.base + 1n, (l) => l.args?.key === key, 120_000),
      ];
      const ws = watchers();
      let mintSeen!: () => void;
      const minted = new Promise<void>((r) => { mintSeen = r; });
      if (VERBOSE) ["Lasna  PauseRequested (detection)", "gate U Paused (Unichain)", "gate B Paused (Base)"].forEach((name, j) =>
        void ws[j].then(async (hit) => { await minted; say(hit ? `${name}  ${rel(hit.at)}  tx ${hit.tx}` : `${name}: not seen (timeout)`); }));
      say(`forged mint: key ${key}, ${amount / E18} tUSD to the attacker, no lock behind it on Base`);
      const mint = await send(UNI, A.MINTER, minterAbi, "mint", [key, attacker, amount]);
      T0.at = mint.minedAt; mintSeen();
      say(`mint mined on Unichain  tx ${mint.tx}  (t0)`);
      let fired = 0, landed = 0, reverted = "", carryTx = "", carryStatus = "", burstErr = false;
      if (kind === "burst") {
        for (let c = 1; c <= 30; c++) {
          fired = c;
          const cp = await send(UNI, A.MINTER, minterAbi, "mint", [key + BigInt(c), attacker, amount], 300_000n).catch((e) => ({ status: "error", tx: "" as Hex, err: String(e) }));
          if (cp.status === "success") { landed++; say(`copycat ${c} landed  ${rel(Date.now())}`); }
          else if (cp.status === "reverted" && cp.tx) { reverted = cp.tx; say(`copycat ${c} reverted  ${rel(Date.now())}  tx ${cp.tx}`); break; } // only a mined revert is the stopping revert
          else { burstErr = true; note += `copycat ${c} send failed (no mined revert): ${(cp as { err?: string }).err?.slice(0, 80) ?? cp.status}; `; break; }
        }
        const rel2 = await send(BASE, A.LOCKBOX, lockboxAbi, "releaseByRelayer", [key + 1000n, attacker, amount], 300_000n).catch((e) => ({ status: `error:${String(e).slice(0, 40)}`, tx: "" as Hex }));
        carryTx = rel2.tx; carryStatus = rel2.status;
        say(`forged release on Base (carry-home): ${rel2.status}${rel2.tx ? `  tx ${rel2.tx}` : ""}`);
      }
      const [pl, pu, pb] = await Promise.all(ws);
      if (pl && pu && pb) say(`both gates shut  ${rel(Math.max(pu.at, pb.at))}`);
      const mined = mint.minedAt;
      Object.assign(row, { key, recipient: attacker, mint_tx: mint.tx, mint_sent_ms: mint.sentAt, mint_mined_ms: mined, mint_block_ts: await blockTs(UNI, mint.block),
        lasna_seen_ms: pl?.at, lasna_tx: pl?.tx, lasna_block_ts: await blockTs(LASNA, pl?.block),
        gate_u_seen_ms: pu?.at, gate_u_tx: pu?.tx, gate_u_block_ts: await blockTs(UNI, pu?.block),
        gate_b_seen_ms: pb?.at, gate_b_tx: pb?.tx, gate_b_block_ts: await blockTs(BASE, pb?.block),
        pause_epoch: pl?.args?.epoch, copycats_fired: kind === "burst" ? fired : "", copycats_landed: kind === "burst" ? landed : "", reverted_tx: reverted,
        carry_home_tx: carryTx, carry_home_status: carryStatus, exposure_tusd: kind === "burst" ? (1 + landed) * 500 : 500,
        outcome: burstErr ? "error" : pl && pu && pb ? (kind === "burst" && !reverted ? "censored" : "ok") : "timeout" });
      const r = await recover([attacker], hd0, (pl?.args?.epoch as bigint | undefined) ?? 0n);
      markRec(r.ok);
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
  row.recovery = recovery;
  emit(row);
}
