// Read-only check of every burst row's stopping copycat, on Unichain Sepolia (no key, no transaction):
//  after          the reverted copycat executed strictly after the gate U Paused tx (later block, or same block and higher transactionIndex)
//  paused_event_ok the gate U receipt contains the gate's Paused event for this run's key
//  reason         GatePaused when an eth_call of the copycat's original input at its block returns revert data with selector 0x726461f5
//                 (GatePaused()); "unavailable" when the node refuses that historical state or returns no revert data
// Usage: tsx scripts/burst-verify.ts [evidence/frozen3-bench-runs.csv]   -> evidence/<instance>-burst-verify.csv
import { readFileSync, writeFileSync } from "node:fs";
import { parseEventLogs, parseAbi } from "viem";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { parseCsvLine, type Hex } from "../packages/reactive-kit/ts/triples.ts";

const UNI = 1301;
const GATE_PAUSED = "0x726461f5"; // GatePaused()
const pausedAbi = parseAbi(["event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)"]);
const path = process.argv[2] ?? "evidence/frozen3-bench-runs.csv";
const base = path.replace(/-bench-runs\.csv$/, "");
const GATE_U = (readFileSync(`${base}-addresses.txt`, "utf8").split("\n").find((l) => l.startsWith("GATE_U="))?.split("=")[1] ?? "").trim().toLowerCase();
const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
const cols = parseCsvLine(head);
const rows = lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i], v]))) as Record<string, string>[];
const out = ["run_id,reverted_tx,reverted_status,reverted_block,reverted_tx_index,gate_u_paused_block,gate_u_tx_index,paused_event_ok,reverted_after_pause,reason"];
const c = client(UNI);
/** revert data of an eth_call at `block`, or null when the node gives none */
async function revertData(txHash: Hex, block: bigint): Promise<Hex | null> {
  const t = await c.getTransaction({ hash: txHash });
  try { await c.call({ account: t.from, to: t.to!, data: t.input, blockNumber: block }); return null; }
  catch (e) {
    const d = (e as { walk?: (f: (x: unknown) => boolean) => { data?: unknown } | null }).walk?.((x) => typeof (x as { data?: unknown })?.data === "string" && ((x as { data: string }).data).startsWith("0x"));
    return typeof d?.data === "string" ? (d.data as Hex) : null;
  }
}
let after = 0, evOk = 0, gp = 0, unavail = 0, total = 0;
for (const r of rows.filter((x) => x.kind === "burst" && x.reverted_tx)) {
  const [rv, g] = await Promise.all([
    c.getTransactionReceipt({ hash: r.reverted_tx as Hex }),
    r.gate_u_tx ? c.getTransactionReceipt({ hash: r.gate_u_tx as Hex }) : Promise.resolve(null),
  ]);
  const isAfter = g && rv.status === "reverted" && (rv.blockNumber > g.blockNumber || (rv.blockNumber === g.blockNumber && rv.transactionIndex > g.transactionIndex)) ? 1 : 0;
  const paused = g ? parseEventLogs({ abi: pausedAbi, eventName: "Paused", logs: g.logs }).some((l) => l.address.toLowerCase() === GATE_U && String(l.args.key) === r.key) : false;
  let reason = "unavailable";
  try { const d = await revertData(r.reverted_tx as Hex, rv.blockNumber); if (d && d.slice(0, 10).toLowerCase() === GATE_PAUSED) reason = "GatePaused"; } catch { /* node refused historical state */ }
  after += isAfter; evOk += paused ? 1 : 0; total++; reason === "GatePaused" ? gp++ : unavail++;
  out.push([r.run_id, r.reverted_tx, rv.status, rv.blockNumber, rv.transactionIndex, g?.blockNumber ?? "", g?.transactionIndex ?? "", paused ? 1 : 0, isAfter, reason].join(","));
}
writeFileSync(`${base}-burst-verify.csv`, out.join("\n") + "\n");
console.log(`${base}-burst-verify.csv: after=1 on ${after}/${total}; paused_event_ok=1 on ${evOk}/${total}; reason=GatePaused ${gp}/${total}; other/unavailable ${unavail}/${total}`);
