// Builds status/data/status.json (what the read-only status page renders) from committed evidence. Nothing is typed in.
// Usage: tsx scripts/status-data.ts [instance]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseCsvLine } from "../packages/reactive-kit/ts/triples.ts";

const instance = process.argv[2] ?? "frozen";
const csv = (p: string) => {
  if (!existsSync(p)) return [] as Record<string, string>[];
  const [h, ...ls] = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const c = parseCsvLine(h);
  return ls.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [c[i], v]))) as Record<string, string>[];
};
const kv = (p: string) => Object.fromEntries(readFileSync(p, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.replace(/\s+#.*$/, "").split("=") as [string, string]));
const num = (v: string) => (v === "" || v === undefined ? null : Number(v));
const runs = csv(`evidence/${instance}-bench-runs.csv`).map((r) => ({
  id: r.run_id, kind: r.kind, outcome: r.outcome, amount: num(r.amount_tusd),
  detection_s: r.lasna_seen_ms && r.mint_mined_ms ? (Number(r.lasna_seen_ms) - Number(r.mint_mined_ms)) / 1000 : null,
  pause_u_s: r.gate_u_seen_ms && r.mint_mined_ms ? (Number(r.gate_u_seen_ms) - Number(r.mint_mined_ms)) / 1000 : null,
  pause_b_s: r.gate_b_seen_ms && r.mint_mined_ms ? (Number(r.gate_b_seen_ms) - Number(r.mint_mined_ms)) / 1000 : null,
  landed: num(r.copycats_landed), fired: num(r.copycats_fired), exposure_tusd: num(r.exposure_tusd), pause_seconds: num(r.pause_seconds),
  false_pause: r.false_pause === "1", booked_s: r.kind === "legit_strict" && r.lasna_seen_ms ? (Number(r.lasna_seen_ms) - Number(r.mint_mined_ms)) / 1000 : null,
  mint_ms: num(r.mint_mined_ms), mint_tx: r.mint_tx, lasna_tx: r.lasna_tx, gate_u_tx: r.gate_u_tx, gate_b_tx: r.gate_b_tx, reverted_tx: r.reverted_tx, carry_home_tx: r.carry_home_tx, carry_home_status: r.carry_home_status,
}));
const incident = [...runs].reverse().find((r) => r.kind !== "legit_strict" && r.kind !== "legit_forced" && r.outcome === "ok" && r.gate_b_tx) ?? null;
const triples = csv(`evidence/${instance}-triples.csv`).slice(-50).reverse().map((t) => ({
  ts: t.trigger_ts, kind: t.trigger_kind, trigger_chain: t.trigger_chain, trigger_tx: t.trigger_tx, reactive_tx: t.reactive_tx, callback_chain: t.callback_chain, callback_tx: t.callback_tx, note: t.note,
}));
const skew = csv("evidence/skew-pairs.csv").map((r) => ({ skew_s: num(r.skew_s), mint_seen_first: r.mint_seen_first === "true" }));
const summaryPath = `evidence/${instance}-bench-summary.json`;
const a0 = csv("evidence/a0-control-runs.csv");
const aArm = runs.filter((r) => /^bu-02[1-5]$/.test(r.id));
const control = a0.length ? {
  a0: { runs: a0.length, issued_per_run: a0.map((r) => Number(r.unauthorized_issuance_tusd)), released_per_run: a0.map((r) => Number(r.collateral_released_tusd)), carry_home: a0.map((r) => r.release_status) },
  a: { runs: aArm.length, issued_per_run: aArm.map((r) => (r.exposure_tusd ?? 0)), released_per_run: aArm.map((r) => (r.carry_home_status === "success" ? 500 : 0)), carry_home: aArm.map((r) => r.carry_home_status) },
} : null;
const rb = csv(`evidence/${instance}-routeb-runs.csv`);
const routeBRuns = { legit: rb.filter((r) => r.kind === "legit").length, legit_false_latch: rb.filter((r) => r.kind === "legit" && r.false_latch === "1").length, delay_s: rb.filter((r) => r.kind === "legit").map((r) => Number(r.delay_s)),
  drills: rb.filter((r) => r.kind === "drill").map((r) => ({ id: r.run_id, pause_u_s: Number(r.pause_u_s), pause_b_s: Number(r.pause_b_s), held: r.held_process_status, pause_u_tx: r.pause_u_tx, pause_b_tx: r.pause_b_tx, pause_lasna_tx: r.pause_lasna_tx, held_tx: r.held_process_tx, delivered_tx: r.process_tx })) };
const out = {
  generated_at: new Date().toISOString(), instance,
  addresses: kv(`evidence/${instance}-addresses.txt`),
  routeB: existsSync("evidence/route-b-addresses.txt") ? { ...kv("evidence/route-b-addresses.txt"), ...(existsSync("evidence/route-b-guard.txt") ? kv("evidence/route-b-guard.txt") : {}) } : null,
  routeBRuns, control,
  summary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null,
  runs, incident, triples, skew,
  forced: runs.filter((r) => r.kind === "legit_forced").map((r) => r.pause_seconds),
};
writeFileSync("status/data/status.json", JSON.stringify(out) + "\n");
console.log(`status.json: ${runs.length} runs, ${triples.length} triples, summary ${out.summary ? "yes" : "no"}`);
