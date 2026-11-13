// Joins a core-flow deployment's live loop into evidence rows, from chain logs only (regenerated on every run, no append):
//   evidence/<instance>-triples.csv          origin tx -> Lasna react tx -> gate callback tx (one row per callback leg;
//                                            no-op rows have no callback); resolve() rows start from the Lasna tx itself
//   evidence/<instance>-react-gas.csv        gas per Lasna tx + branch + CallbackRequest count, read from receipts
//   evidence/<instance>-callback-failures.csv raw CallbackFailure logs on each destination proxy for this instance's gates
// Usage: tsx scripts/triples.ts [evidence/core-dev-addresses.txt]
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, keccak256, parseAbi, toHex, type Log } from "viem";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { buildTriple, toCsvLine, TRIPLE_COLUMNS, type Hex, type TripleRow } from "../packages/reactive-kit/ts/triples.ts";

const LASNA = 5318007, BASE = 84532, UNI = 1301;
const PROXY: Record<number, Hex> = { [BASE]: "0x476F44b11F5C942c58f4c8E3d0300E5710743585", [UNI]: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1" };
const addrFile = process.argv[2] ?? "evidence/core-dev-addresses.txt";
const A = Object.fromEntries(
  readFileSync(addrFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string]),
);
const INSTANCE = A.INSTANCE;
const STAGE = (process.env.STAGE ?? INSTANCE).toUpperCase();

// Must match src/LedgerlockReactive.sol (Side, Cause) and src/Gate.sol.
const SIDE = ["LOCK", "MINT", "BURN", "RELEASE", "ACK_PAUSED", "ACK_RESUMED", "HELD", "FAIL", "SEIZED", "DRILL"];
const CAUSE = ["NONE", "REPEAT", "LATE_LOCK", "OVERDUE", "FLOOD", "FAILSAFE", "SUPPLY", "DRILL"];
const rcAbi = parseAbi([
  "event RouteAdded(uint256 indexed routeId, uint8 mode, uint256 srcChain, uint256 dstChain)",
  "event Observed(uint256 indexed routeId, uint8 side, uint256 key, bytes32 indexed originTx)",
  "event Mismatch(uint256 indexed routeId, uint8 side, uint256 key, uint256 amount, address to, bytes32 indexed originTx, uint64 epoch)",
  "event Matched(uint256 indexed routeId, uint256 key, bytes32 indexed originTx, uint32 waitedSec)",
  "event IncidentLatched(uint256 indexed routeId, uint8 cause, uint64 epoch)",
  "event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event ResumeRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event AckSeen(uint256 indexed routeId, uint256 chainId, uint8 side, uint64 epoch)",
  "event Retried(uint256 indexed routeId, uint256 chainId, uint64 epoch)",
  "event GateUnreachable(uint256 indexed routeId, uint256 chainId, uint64 epoch)",
  "event Resolved(uint256 indexed routeId, uint8 reason, uint256 unbacked, uint256 unbackedRel, bool deficitAccepted, uint64 epoch)",
  "event Remediated(uint256 indexed routeId, uint256 amount, bytes32 indexed originTx)",
  "event CronWatch(bool on)",
]);
const gateAbi = parseAbi([
  "event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)",
  "event HeldByGuardian(uint256 indexed routeId, uint64 epoch)",
  "event StaleEpoch(uint64 epoch, uint64 lastEpoch)",
]);
const failAbi = parseAbi(["event CallbackFailure(address indexed target, bytes payload)"]);
const CALLBACK_REQUEST_T0 = "0xef94dbc611c4b95bf4b8ba34b413972180c2faf26fbb480befacedd83e07b133";
const SYSTEM = "0x8888888888888888888888888888888888888888";
const IGNORED_T0 = new Set(["GuardianSet(address)", "TargetSet(address)", "GuardianAction(bool)"].map((s) => keccak256(toHex(s))));

type D = { name: string; args: Record<string, unknown>; log: Log };
function dec(abi: typeof rcAbi | typeof gateAbi, logs: Log[], label: string): D[] {
  const out: D[] = [];
  const unknown = new Map<string, number>();
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics as never });
      out.push({ name: d.eventName, args: d.args as Record<string, unknown>, log: l });
    } catch {
      const t0 = String(l.topics[0]);
      if (!IGNORED_T0.has(t0 as Hex)) unknown.set(t0, (unknown.get(t0) ?? 0) + 1);
    }
  }
  for (const [t0, n] of unknown) console.warn(`WARN ${label}: ${n} log(s) with undecodable topic0 ${t0}`);
  return out;
}

// Unichain Sepolia's public RPC caps eth_getLogs at 1,000 blocks; Base Sepolia's at a few hundred.
const SPAN: Record<number, bigint> = { [BASE]: 180n, [UNI]: 999n, [LASNA]: 5000n };
async function allLogs(chainId: number, address: Hex, from: bigint, filter?: Record<string, unknown>): Promise<Log[]> {
  const c = client(chainId);
  const to = await c.getBlockNumber();
  const out: Log[] = [];
  for (let f = from; f <= to; f += SPAN[chainId] + 1n) {
    const e = f + SPAN[chainId] > to ? to : f + SPAN[chainId];
    const q = filter ? { address, event: failAbi[0], args: filter, fromBlock: f, toBlock: e } : { address, fromBlock: f, toBlock: e };
    out.push(...((await c.getLogs(q as never)) as Log[]));
  }
  return out;
}

const rc = dec(rcAbi, await allLogs(LASNA, A.RC as Hex, BigInt(A.LASNA_FROM) - 50n), "rc");
const gates: Record<number, D[]> = {
  [BASE]: dec(gateAbi, await allLogs(BASE, A.GATE_B as Hex, BigInt(A.BASE_FROM) - 50n), "gate_b"),
  [UNI]: dec(gateAbi, await allLogs(UNI, A.GATE_U as Hex, BigInt(A.UNI_FROM) - 50n), "gate_u"),
};
const byTx = new Map<string, D[]>();
for (const d of rc) byTx.set(d.log.transactionHash!, [...(byTx.get(d.log.transactionHash!) ?? []), d]);

// A gate event joins a request on (operation, epoch, origin tx, key). A retry re-emits the same ack, so the FIRST match
// is the callback that executed the request; later matches are counted in the note.
function gateEvents(chainId: number, paused: boolean, epoch: bigint, originTx: Hex, key: bigint): D[] {
  return gates[chainId].filter((d) => d.name === (paused ? "Paused" : "Resumed") && d.args.epoch === epoch &&
    d.args.originTx === originTx && d.args.key === key);
}
const ackFor = (chainId: number, paused: boolean, epoch: bigint) =>
  rc.find((d) => d.name === "AckSeen" && BigInt(d.args.chainId as bigint) === BigInt(chainId) &&
    SIDE[Number(d.args.side)] === (paused ? "ACK_PAUSED" : "ACK_RESUMED") && d.args.epoch === epoch);

const keyed: { k: [bigint, number, number]; row: TripleRow }[] = [];
const gasRows = ["reactive_tx,lasna_block,branch,gas_used,callbacks_requested,cron_subscribe,cron_unsubscribe,latch,instance"];
const trigChainOf = (side: string) => (side === "LOCK" || side === "RELEASE" || side === "DRILL" ? BASE : UNI);

for (const [tx, ds] of byTx) {
  const obs = ds.find((d) => d.name === "Observed");
  const req = ds.find((d) => d.name === "PauseRequested" || d.name === "ResumeRequested");
  const latch = ds.find((d) => d.name === "IncidentLatched");
  const cron = ds.filter((d) => d.name === "CronWatch");
  const r = await client(LASNA).getTransactionReceipt({ hash: tx as Hex });
  const nCb = r.logs.filter((l) => l.address.toLowerCase() === SYSTEM && l.topics[0] === CALLBACK_REQUEST_T0).length;
  const side = obs ? SIDE[Number(obs.args.side)] : undefined;
  let branch = "other";
  if (side) {
    const tag = req ? (req.name === "PauseRequested" ? "_pause" : "_resume") : ds.some((d) => d.name === "Mismatch") ? "_unmatched_paused" : "";
    branch = side.toLowerCase() + tag;
    if (ds.some((d) => d.name === "Retried")) branch += "_retry";
  } else if (ds.some((d) => d.name === "Resolved")) branch = "resolve_external";
  else if (ds.some((d) => d.name === "RouteAdded")) branch = "add_route";
  else if (ds.some((d) => d.name === "Retried" || d.name === "GateUnreachable")) branch = "cron_watchdog";
  gasRows.push([tx, r.blockNumber, branch, r.gasUsed, nCb, cron.some((d) => d.args.on === true), cron.some((d) => d.args.on === false),
    latch ? CAUSE[Number(latch.args.cause)] : "", INSTANCE].join(","));
  if (!side || side.startsWith("ACK") || side === "HELD" || side === "FAIL") continue;
  const originTx = obs!.args.originTx as Hex;
  const base = { stage: STAGE, seq: 0, triggerKind: "origin_log" as const, triggerChain: trigChainOf(side), triggerTx: originTx, reactiveChain: LASNA, reactiveTx: tx as Hex, instance: INSTANCE };
  const latchNote = latch ? `; latched ${CAUSE[Number(latch.args.cause)]}` : "";
  if (!req) {
    keyed.push({ k: [r.blockNumber, obs!.log.logIndex!, 0], row: await buildTriple({ ...base, note: `${branch}: no callback${latchNote}; key=${obs!.args.key}` }) });
    continue;
  }
  const paused = req.name === "PauseRequested";
  const epoch = req.args.epoch as bigint;
  for (const cbChain of [UNI, BASE]) {
    const g = gateEvents(cbChain, paused, epoch, req.args.originTx as Hex, req.args.key as bigint);
    const ack = ackFor(cbChain, paused, epoch);
    keyed.push({ k: [r.blockNumber, req.log.logIndex!, cbChain === UNI ? 1 : 2], row: await buildTriple({
      ...base,
      callback: g[0] ? { chainId: cbChain, tx: g[0].log.transactionHash! } : undefined,
      lastActivity: ack ? { chainId: LASNA, tx: ack.log.transactionHash! } : undefined,
      note: `${branch}: ${paused ? "pause" : "resume"} epoch ${epoch} (${nCb} CallbackRequest logs in this react)${latchNote}; key=${obs!.args.key}; ${g.length ? (g.length > 1 ? `${g.length} gate acks (re-emitted after a retry); ` : "") : "NO gate event found; "}${ack ? "last_activity = gate ack observed on Lasna" : "no gate ack on Lasna"}`,
    }) });
  }
}
// resolve(): a plain external Lasna tx requesting the resume callbacks (the trigger is the Lasna tx itself)
for (const d of rc.filter((x) => x.name === "ResumeRequested" && !byTx.get(x.log.transactionHash!)!.some((y) => y.name === "Observed"))) {
  const epoch = d.args.epoch as bigint;
  for (const cbChain of [UNI, BASE]) {
    const g = gateEvents(cbChain, false, epoch, d.args.originTx as Hex, d.args.key as bigint);
    const ack = ackFor(cbChain, false, epoch);
    keyed.push({ k: [d.log.blockNumber!, d.log.logIndex!, cbChain === UNI ? 1 : 2], row: await buildTriple({
      stage: STAGE, seq: 0, triggerKind: "origin_log", triggerChain: LASNA, triggerTx: d.log.transactionHash!, reactiveChain: LASNA, reactiveTx: d.log.transactionHash!,
      callback: g[0] ? { chainId: cbChain, tx: g[0].log.transactionHash! } : undefined,
      lastActivity: ack ? { chainId: LASNA, tx: ack.log.transactionHash! } : undefined,
      instance: INSTANCE,
      note: `resolve_external: owner resolve() requests the resume callbacks from a plain external method; epoch ${epoch}; ${g.length ? "" : "NO gate event found; "}`,
    }) });
  }
}
keyed.sort((a, b) => (a.k[0] < b.k[0] ? -1 : a.k[0] > b.k[0] ? 1 : a.k[1] - b.k[1] || a.k[2] - b.k[2]));
const rows = keyed.map((x, i) => ({ ...x.row, seq: String(i + 1) }));
writeFileSync(`evidence/${INSTANCE}-triples.csv`, [TRIPLE_COLUMNS.join(","), ...rows.map(toCsvLine)].join("\n") + "\n");
writeFileSync(`evidence/${INSTANCE}-react-gas.csv`, gasRows.join("\n") + "\n");

const failRows = ["chain_id,proxy,tx,block,target,selector,epoch,instance"];
for (const [chainId, gate, from] of [[BASE, A.GATE_B, A.BASE_FROM], [UNI, A.GATE_U, A.UNI_FROM]] as const) {
  for (const l of await allLogs(chainId, PROXY[chainId], BigInt(from), { target: gate })) {
    const d = decodeEventLog({ abi: failAbi, data: l.data, topics: l.topics as never });
    const p = d.args.payload as Hex;
    const epochWord = p.length >= 2 + 8 + 64 * 3 ? BigInt("0x" + p.slice(10 + 128, 10 + 192)) : "";
    failRows.push([chainId, PROXY[chainId], l.transactionHash, l.blockNumber, d.args.target, p.slice(0, 10), String(epochWord), INSTANCE].join(","));
  }
}
writeFileSync(`evidence/${INSTANCE}-callback-failures.csv`, failRows.join("\n") + "\n");
console.log(`${INSTANCE}: triples ${rows.length}; gas rows ${gasRows.length - 1}; failures ${failRows.length - 1}`);
