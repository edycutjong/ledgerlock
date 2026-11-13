// Read-only check of every burst row's stopping copycat: was the reverted mint mined (status reverted) in or after the block where
// gate U emitted Paused? Fetches the receipts of reverted_tx and gate_u_tx on Unichain Sepolia (no key, no transaction).
// Usage: tsx scripts/burst-verify.ts [evidence/frozen-bench-runs.csv]   -> evidence/<instance>-burst-verify.csv
import { readFileSync, writeFileSync } from "node:fs";
import { client } from "../packages/reactive-kit/ts/chains.ts";
import { parseCsvLine, type Hex } from "../packages/reactive-kit/ts/triples.ts";

const UNI = 1301;
const path = process.argv[2] ?? "evidence/frozen-bench-runs.csv";
const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
const cols = parseCsvLine(head);
const rows = lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [cols[i], v]))) as Record<string, string>[];
const out = ["run_id,reverted_tx,reverted_status,reverted_block,gate_u_paused_block,reverted_after_pause"];
let ones = 0, total = 0;
for (const r of rows.filter((x) => x.kind === "burst" && x.reverted_tx)) {
  const [rv, g] = await Promise.all([
    client(UNI).getTransactionReceipt({ hash: r.reverted_tx as Hex }),
    r.gate_u_tx ? client(UNI).getTransactionReceipt({ hash: r.gate_u_tx as Hex }) : Promise.resolve(null),
  ]);
  const after = g && rv.status === "reverted" && rv.blockNumber >= g.blockNumber ? 1 : 0;
  ones += after; total++;
  out.push([r.run_id, r.reverted_tx, rv.status, rv.blockNumber, g?.blockNumber ?? "", after].join(","));
}
const base = path.replace(/-bench-runs\.csv$/, "");
writeFileSync(`${base}-burst-verify.csv`, out.join("\n") + "\n");
console.log(`${base}-burst-verify.csv: reverted_after_pause = 1 on ${ones} of ${total} burst rows`);
