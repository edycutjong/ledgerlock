// Read-only on-chain cross-check of the route B drills: whole-second block timestamps of the DrillBeacon.fire() tx (Base) and of
// the gate Paused txs (Unichain gate U, Base gate B), from evidence/frozen-routeb-runs.csv. No key, no transaction.
// Usage: tsx scripts/routeb-blockts.ts   -> evidence/frozen-routeb-blockts.csv
import { readFileSync, writeFileSync } from "node:fs";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { parseCsvLine, type Hex } from "../packages/reactive-kit/ts/triples.ts";

const UNI = 1301, BASE = 84532;
const [head, ...lines] = readFileSync("evidence/frozen-routeb-runs.csv", "utf8").split("\n").filter(Boolean);
const cols = parseCsvLine(head);
const rows = lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i], v]))) as Record<string, string>[];
const ts = async (chain: number, tx: string) => {
  if (!tx) return "";
  const r = await client(chain).getTransactionReceipt({ hash: tx as Hex });
  return String(Number((await client(chain).getBlock({ blockNumber: r.blockNumber })).timestamp));
};
const out = ["run_id,fire_tx,fire_block_ts,pause_u_tx,pause_u_block_ts,pause_b_tx,pause_b_block_ts"];
for (const r of rows.filter((x) => x.kind === "drill" && x.send_tx && x.pause_u_tx && x.pause_b_tx))
  out.push([r.run_id, r.send_tx, await ts(BASE, r.send_tx), r.pause_u_tx, await ts(UNI, r.pause_u_tx), r.pause_b_tx, await ts(BASE, r.pause_b_tx)].join(","));
writeFileSync("evidence/frozen-routeb-blockts.csv", out.join("\n") + "\n");
console.log(`evidence/frozen-routeb-blockts.csv: ${out.length - 1} drill rows`);
