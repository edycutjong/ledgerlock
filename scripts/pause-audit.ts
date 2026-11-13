// Independent check of "false pauses": every PauseRequested the guard ever emitted on this deployment, joined to the run that
// caused it. A pause whose origin tx is a legit_strict mint would be a false pause. Reads chain logs; writes
// evidence/<instance>-pause-audit.csv. Usage: tsx scripts/pause-audit.ts [instance]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseAbi, type Hex } from "viem";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { parseCsvLine } from "../packages/reactive-kit/ts/triples.ts";

const inst = process.argv[2] ?? "frozen";
const A = Object.fromEntries(readFileSync(`evidence/${inst}-addresses.txt`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string])) as Record<string, Hex>;
const csv = (p: string) => { if (!existsSync(p)) return []; const [h, ...ls] = readFileSync(p, "utf8").split("\n").filter(Boolean); const c = parseCsvLine(h); return ls.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [c[i], v]))) as Record<string, string>[]; };
const byTx = new Map<string, string>();
for (const f of [`evidence/${inst}-bench-runs.csv`, `evidence/${inst}-heartbeat-runs.csv`]) for (const r of csv(f)) if (r.mint_tx) byTx.set(r.mint_tx.toLowerCase(), `${r.kind}:${r.run_id}`);
for (const r of csv(`evidence/${inst}-routeb-runs.csv`)) if (r.send_tx && r.kind === "drill") byTx.set(r.send_tx.toLowerCase(), `route_b_drill:${r.run_id}`);
const abi = parseAbi(["event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)"]);
const c = client(5318007), head = await c.getBlockNumber();
const rows = ["lasna_block,lasna_tx,route,epoch,origin_tx,matched_run"]; const tally: Record<string, number> = {};
for (let f = BigInt(A.LASNA_FROM); f <= head; f += 5001n) {
  const to = f + 5000n > head ? head : f + 5000n;
  for (const l of await c.getLogs({ address: A.RC, event: abi[0], fromBlock: f, toBlock: to })) {
    const a = l.args as { routeId: bigint; epoch: bigint; originTx: Hex };
    const m = byTx.get(a.originTx.toLowerCase()) ?? "UNMATCHED";
    rows.push([l.blockNumber, l.transactionHash, a.routeId, a.epoch, a.originTx, m].join(","));
    const k = m.split(":")[0]; tally[k] = (tally[k] ?? 0) + 1;
  }
}
writeFileSync(`evidence/${inst}-pause-audit.csv`, rows.join("\n") + "\n");
const strictMints = new Set([...byTx].filter(([, v]) => v.startsWith("legit_strict:")).map(([k]) => k));
console.log(JSON.stringify({ pauses: rows.length - 1, tally, legit_strict_mints: strictMints.size, pauses_on_legit_strict: tally["legit_strict"] ?? 0 }));
