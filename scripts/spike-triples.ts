// Joins the spike (dev) deployment's live loop into evidence rows, from chain logs only:
//   evidence/triples.csv      origin tx -> Lasna react tx -> gate callback tx (one row per callback; no-op rows have no callback)
//   evidence/react-gas.csv    gas used per react() branch, read from Lasna receipts (probe 1)
//   evidence/callback-failures.csv  raw CallbackFailure logs on each destination proxy for our gates (probe 3)
//   evidence/hop-probe.csv    self-callback to Lasna (probe 2) + Cron subscribe/unsubscribe from react() (probe 2)
// Usage: tsx scripts/spike-triples.ts [evidence/spike-addresses.txt]
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, parseAbi, type Log } from "viem";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { buildTriple, toCsvLine, txInfo, TRIPLE_COLUMNS, type Hex, type TripleRow } from "../packages/reactive-kit/ts/triples.ts";

const LASNA = 5318007, BASE = 84532, UNI = 1301;
const PROXY: Record<number, Hex> = { [BASE]: "0x476F44b11F5C942c58f4c8E3d0300E5710743585", [UNI]: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1" };

const addrFile = process.argv[2] ?? "evidence/spike-addresses.txt";
const A = Object.fromEntries(
  readFileSync(addrFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string]),
);
const INSTANCE = A.INSTANCE;

const rcAbi = parseAbi([
  "event Observed(uint256 indexed routeId, uint8 side, uint256 key, bytes32 indexed originTx)",
  "event Mismatch(uint256 indexed routeId, uint256 key, uint256 amount, address to, bytes32 indexed originTx, uint64 epoch)",
  "event Matched(uint256 indexed routeId, uint256 key, bytes32 indexed originTx, uint32 waitedSec)",
  "event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event ResumeRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event AckSeen(uint256 indexed routeId, uint256 chainId, bool pausedAck, uint64 epoch, bytes32 indexed originTx)",
  "event Resolved(uint256 indexed routeId, uint256 cleared, uint256 unbacked, uint64 epoch)",
  "event HopRequested(uint256 indexed seq)",
  "event HopSeen(uint256 indexed seq, address sender, address rvm, bool authorised)",
  "event CronProbe(uint8 stage, uint256 at)",
]);
const gateAbi = parseAbi([
  "event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
]);
const failAbi = parseAbi(["event CallbackFailure(address indexed target, bytes payload)"]);
// CallbackRequest(uint256 indexed chain_id, address indexed contract, address indexed target, ...) emitted by the system contract
const CALLBACK_REQUEST_T0 = "0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133";
const SYSTEM = "0x8888888888888888888888888888888888888888";
const SIDE = ["LOCK", "MINT", "ACK_PAUSED", "ACK_RESUMED"];

type D = { name: string; args: Record<string, unknown>; log: Log };
function dec(abi: typeof rcAbi | typeof gateAbi, logs: Log[]): D[] {
  const out: D[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics as never });
      out.push({ name: d.eventName, args: d.args as Record<string, unknown>, log: l });
    } catch { /* not ours */ }
  }
  return out;
}

// Unichain Sepolia's public RPC caps eth_getLogs at 1,000 blocks (the kit's 2,000 default is too wide there).
const SPAN: Record<number, bigint> = { [BASE]: 180n, [UNI]: 999n, [LASNA]: 5000n };
async function allLogs(chainId: number, address: Hex, from: bigint, filter?: { event: (typeof failAbi)[0]; args: Record<string, unknown> }): Promise<Log[]> {
  const c = client(chainId);
  const to = await c.getBlockNumber();
  const span = SPAN[chainId];
  const out: Log[] = [];
  for (let f = from; f <= to; f += span + 1n) {
    const e = f + span > to ? to : f + span;
    const q = filter ? { address, event: filter.event, args: filter.args as never, fromBlock: f, toBlock: e } : { address, fromBlock: f, toBlock: e };
    out.push(...((await c.getLogs(q as never)) as Log[]));
  }
  return out;
}

const rc = dec(rcAbi, await allLogs(LASNA, A.RC as Hex, BigInt(A.LASNA_FROM) - 50n));
const gates: Record<number, D[]> = {
  [BASE]: dec(gateAbi, await allLogs(BASE, A.GATE_B as Hex, BigInt(A.BASE_FROM) - 50n)),
  [UNI]: dec(gateAbi, await allLogs(UNI, A.GATE_U as Hex, BigInt(A.UNI_FROM) - 50n)),
};
const byTx = new Map<string, D[]>();
for (const d of rc) byTx.set(d.log.transactionHash!, [...(byTx.get(d.log.transactionHash!) ?? []), d]);

const keyed: { k: [bigint, number, number]; row: TripleRow }[] = []; // (lasna block, log index, callback leg) -> stable order
const gasRows: string[] = ["reactive_tx,lasna_block,branch,gas_used,callbacks_requested,instance"];
const ackFor = (chainId: number, paused: boolean, epoch: bigint) =>
  rc.find((d) => d.name === "AckSeen" && BigInt(d.args.chainId as bigint) === BigInt(chainId) && d.args.pausedAck === paused && d.args.epoch === epoch);

for (const [tx, ds] of byTx) {
  const obs = ds.find((d) => d.name === "Observed");
  const req = ds.find((d) => d.name === "PauseRequested" || d.name === "ResumeRequested");
  const lasnaR = await client(LASNA).getTransactionReceipt({ hash: tx as Hex });
  const nCb = lasnaR.logs.filter((l) => l.address.toLowerCase() === SYSTEM && l.topics[0] === CALLBACK_REQUEST_T0).length;
  let branch = "other";
  if (obs) {
    const side = SIDE[Number(obs.args.side)];
    branch = side === "LOCK" ? (req ? "lock_resume" : "lock") : side === "MINT" ? (req ? "mint_pause" : ds.some((d) => d.name === "Matched") ? "mint_matched" : "mint_pending") : "ack";
  } else if (ds.some((d) => d.name === "Resolved")) branch = "resolve_external";
  else if (ds.some((d) => d.name === "HopRequested")) branch = "hop_request_external";
  else if (ds.some((d) => d.name === "HopSeen")) branch = "hop_callback";
  else if (ds.some((d) => d.name === "CronProbe")) branch = "cron_tick";
  gasRows.push([tx, lasnaR.blockNumber, branch, lasnaR.gasUsed, nCb, INSTANCE].join(","));
  if (!obs || branch === "ack") continue; // origin-triggered rows only below (resolve rows are added after)
  const side = SIDE[Number(obs.args.side)];
  const trigChain = side === "LOCK" ? BASE : UNI;
  const originTx = obs.args.originTx as Hex;
  if (!req) {
    const note = branch === "lock" ? "lock recorded; no callback (no-op)" : branch === "mint_matched" ? "mint matched its lock; no callback (no-op)" : "mint pending while already paused; no callback";
    keyed.push({ k: [lasnaR.blockNumber, obs.log.logIndex!, 0], row: await buildTriple({ stage: "SPIKE", seq: 0, triggerKind: "origin_log", triggerChain: trigChain, triggerTx: originTx, reactiveChain: LASNA, reactiveTx: tx as Hex, instance: INSTANCE, note: `${branch}: ${note}; key=${obs.args.key}` }) });
    continue;
  }
  const paused = req.name === "PauseRequested";
  const epoch = req.args.epoch as bigint;
  for (const cbChain of [UNI, BASE]) {
    const g = gates[cbChain].find((d) => d.name === (paused ? "Paused" : "Resumed") && d.args.epoch === epoch);
    const ack = ackFor(cbChain, paused, epoch);
    keyed.push({ k: [lasnaR.blockNumber, req.log.logIndex!, cbChain === UNI ? 1 : 2], row: await buildTriple({
      stage: "SPIKE", seq: 0, triggerKind: "origin_log", triggerChain: trigChain, triggerTx: originTx, reactiveChain: LASNA, reactiveTx: tx as Hex,
      callback: g ? { chainId: cbChain, tx: g.log.transactionHash! } : undefined,
      lastActivity: ack ? { chainId: LASNA, tx: ack.log.transactionHash! } : undefined,
      instance: INSTANCE,
      note: `${branch}: ${paused ? "pause" : "resume"} epoch ${epoch} (${nCb} CallbackRequest logs in this react); key=${obs.args.key}; ${g ? "" : "NO gate event found; "}last_activity = gate ack observed on Lasna`,
    }) });
  }
}
// resolve(): a plain external Lasna tx requesting callbacks (the trigger is the Lasna tx itself)
for (const d of rc.filter((x) => x.name === "ResumeRequested" && !byTx.get(x.log.transactionHash!)!.some((y) => y.name === "Observed"))) {
  const epoch = d.args.epoch as bigint;
  for (const cbChain of [UNI, BASE]) {
    const g = gates[cbChain].find((x) => x.name === "Resumed" && x.args.epoch === epoch);
    const ack = ackFor(cbChain, false, epoch);
    keyed.push({ k: [d.log.blockNumber!, d.log.logIndex!, cbChain === UNI ? 1 : 2], row: await buildTriple({
      stage: "SPIKE", seq: 0, triggerKind: "origin_log", triggerChain: LASNA, triggerTx: d.log.transactionHash!, reactiveChain: LASNA, reactiveTx: d.log.transactionHash!,
      callback: g ? { chainId: cbChain, tx: g.log.transactionHash! } : undefined,
      lastActivity: ack ? { chainId: LASNA, tx: ack.log.transactionHash! } : undefined,
      instance: INSTANCE,
      note: `resolve_external: owner resolve() requests the resume callbacks from a plain external method (no react); epoch ${epoch}; ${g ? "" : "NO gate event found (see callback-failures.csv); "}`,
    }) });
  }
}
// Regenerated from chain logs on every run (no append): seq follows Lasna order, so a re-run reproduces the same file.
keyed.sort((a, b) => (a.k[0] < b.k[0] ? -1 : a.k[0] > b.k[0] ? 1 : a.k[1] - b.k[1] || a.k[2] - b.k[2]));
const rows = keyed.map((x, i) => ({ ...x.row, seq: String(i + 1) }));
writeFileSync("evidence/triples.csv", [TRIPLE_COLUMNS.join(","), ...rows.map(toCsvLine)].join("\n") + "\n");
const added = rows.length;
writeFileSync("evidence/react-gas.csv", gasRows.join("\n") + "\n");

// probe 3: CallbackFailure on each proxy, target = our gate
const failRows = ["chain_id,proxy,tx,block,topic0,target,payload,decoded_selector,decoded_epoch,instance"];
for (const [chainId, gate, from] of [[BASE, A.GATE_B, A.BASE_FROM], [UNI, A.GATE_U, A.UNI_FROM]] as const) {
  const logs = await allLogs(chainId, PROXY[chainId], BigInt(from), { event: failAbi[0], args: { target: gate } });
  for (const l of logs) {
    const d = decodeEventLog({ abi: failAbi, data: l.data, topics: l.topics as never });
    const p = d.args.payload as Hex;
    const epochWord = p.length >= 2 + 8 + 64 * 3 ? BigInt("0x" + p.slice(10 + 128, 10 + 192)) : "";
    failRows.push([chainId, PROXY[chainId], l.transactionHash, l.blockNumber, l.topics[0], d.args.target, p, p.slice(0, 10), String(epochWord), INSTANCE].join(","));
  }
}
writeFileSync("evidence/callback-failures.csv", failRows.join("\n") + "\n");

// probe 2: hop + cron
const hopRows = ["event,lasna_tx,lasna_block,ts,detail,instance"];
for (const d of rc.filter((x) => ["HopRequested", "HopSeen", "CronProbe"].includes(x.name))) {
  const t = await txInfo(LASNA, d.log.transactionHash!);
  const detail = Object.entries(d.args).map(([k, v]) => `${k}=${v}`).join(" ");
  hopRows.push([d.name, d.log.transactionHash, d.log.blockNumber, t.ts, detail, INSTANCE].join(","));
}
writeFileSync("evidence/hop-probe.csv", hopRows.join("\n") + "\n");

// probe 4 (shrunk): arrival order on Lasna of each lock/mint pair with the same key (skew sign; whole-second block timestamps)
const skewRows = ["key,lock_origin_tx,lock_origin_ts,mint_origin_tx,mint_origin_ts,lock_lasna_block,mint_lasna_block,lock_lasna_ts,mint_lasna_ts,skew_s,mint_seen_first,order,instance"];
const obsAll = rc.filter((d) => d.name === "Observed");
for (const m of obsAll.filter((d) => SIDE[Number(d.args.side)] === "MINT")) {
  const l = obsAll.find((d) => SIDE[Number(d.args.side)] === "LOCK" && d.args.key === m.args.key);
  if (!l) continue;
  const [lo, mo, ll, ml] = await Promise.all([
    txInfo(BASE, l.args.originTx as Hex), txInfo(UNI, m.args.originTx as Hex),
    txInfo(LASNA, l.log.transactionHash!), txInfo(LASNA, m.log.transactionHash!),
  ]);
  skewRows.push([m.args.key, l.args.originTx, lo.ts, m.args.originTx, mo.ts, l.log.blockNumber, m.log.blockNumber, ll.ts, ml.ts,
    ml.ts - ll.ts, m.log.blockNumber! < l.log.blockNumber!,
    mo.ts < lo.ts ? "forced_mint_first" : "strict_lock_first", INSTANCE].join(","));
}
writeFileSync("evidence/skew-pairs.csv", skewRows.join("\n") + "\n");
console.log(`skew pairs ${skewRows.length - 1}`);
console.log(`triples: ${added} rows; gas rows ${gasRows.length - 1}; failures ${failRows.length - 1}; hop/cron ${hopRows.length - 1}`);
