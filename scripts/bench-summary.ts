// Recomputes every published bench number from the committed rows. Nothing here is typed in by hand.
// Usage: tsx scripts/bench-summary.ts [evidence/frozen3-bench-runs.csv]   -> evidence/<instance>-bench-summary.{json,md}
// Percentiles are nearest-rank (every reported value was observed). Latencies are the off-chain observer's wall clock from
// "attack mint mined" (the observer saw the receipt) to the first poll that saw the log; each is this machine's Date.now() when a
// poll returned (poll interval poll_ms plus RPC latency), with whole-second block-timestamp deltas beside it as the cross-check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseCsvLine } from "../packages/reactive-kit/ts/triples.ts";
import { percentile } from "../packages/reactive-kit/ts/latency.ts";

const path = process.argv[2] ?? "evidence/frozen3-bench-runs.csv";
const [head, ...lines] = readFileSync(path, "utf8").split("\n").filter(Boolean);
const cols = parseCsvLine(head);
const rows = lines.map((l, li) => {
  const v = parseCsvLine(l);
  if (v.length !== cols.length) throw new Error(`${path}:${li + 2}: ${v.length} fields, header has ${cols.length}`); // a misaligned row would silently drop columns
  return Object.fromEntries(v.map((x, i) => [cols[i], x]));
}) as Record<string, string>[];
const n = (v: string) => (v === "" || v === undefined ? NaN : Number(v));
const q = (xs: number[]) => {
  const v = xs.filter(Number.isFinite);
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v.length ? Math.max(...v) : NaN, min: v.length ? Math.min(...v) : NaN };
};
const of = (k: string) => rows.filter((r) => r.kind === k);
const attacks = rows.filter((r) => r.kind.startsWith("attack") || r.kind === "burst");
const okAttacks = attacks.filter((r) => r.outcome === "ok" && !(r.kind === "burst" && Number(r.seq) > 20));
const sec = (a: Record<string, string>, f: string, base = "mint_mined_ms") => (n(a[f]) - n(a[base])) / 1000;
const ms = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);

const lat = (set: Record<string, string>[], base: string) => ({
  detection_s: q(ms(set.map((r) => sec(r, "lasna_seen_ms", base)))),
  pause_gate_u_s: q(ms(set.map((r) => sec(r, "gate_u_seen_ms", base)))),
  pause_gate_b_s: q(ms(set.map((r) => sec(r, "gate_b_seen_ms", base)))),
  pause_both_s: q(ms(set.map((r) => Math.max(sec(r, "gate_u_seen_ms", base), sec(r, "gate_b_seen_ms", base))))),
});
const allBurst = of("burst");
const burst = allBurst.filter((r) => Number(r.seq) <= 20 && r.outcome !== "timeout" && r.outcome !== "error"); // bu-021..025 are the guarded arm of the paired control, counted there
const excluded = rows.filter((r) => r.outcome !== "ok").map((r) => ({ run: r.run_id, outcome: r.outcome, note: r.note }));
const strict = of("legit_strict"), forced = of("legit_forced");
const hasRecovery = cols.includes("recovery");
const recoveryFailed = hasRecovery ? rows.filter((r) => r.recovery === "failed").map((r) => r.run_id) : null;
// Route B drills: block-timestamp cross-check (scripts/routeb-blockts.ts), whole seconds, fire() tx block on Base -> gate Paused tx block
// Route B is guarded by one reactive contract only (ROUTE_B_INSTANCE, default `frozen`; see scripts/triples.ts): a redeployed route A
// instance does not carry it, so its rows are read from that instance's files and labelled as such.
const ROUTE_B_INSTANCE = process.env.ROUTE_B_INSTANCE ?? "frozen";
const evDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const btPath = `${evDir}${ROUTE_B_INSTANCE}-routeb-blockts.csv`;
const bt: Record<string, { u: number; b: number }> = {};
if (existsSync(btPath)) {
  const [h, ...ls] = readFileSync(btPath, "utf8").split("\n").filter(Boolean), hc = parseCsvLine(h);
  for (const l of ls) { const o = Object.fromEntries(parseCsvLine(l).map((v, i) => [hc[i], v])); bt[o.run_id] = { u: n(o.pause_u_block_ts) - n(o.fire_block_ts), b: n(o.pause_b_block_ts) - n(o.fire_block_ts) }; }
}
// Route B (Hyperlane warp route, same guard contract): operator drills + legit transfers, from evidence/frozen-routeb-runs.csv
const rbPath = `${evDir}${ROUTE_B_INSTANCE}-routeb-runs.csv`;
const rb = existsSync(rbPath) ? (() => {
  const [h, ...ls] = readFileSync(rbPath, "utf8").split("\n").filter(Boolean), hc = parseCsvLine(h);
  const rs = ls.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [hc[i], v]))) as Record<string, string>[];
  const legit = rs.filter((r) => r.kind === "legit"), drills = rs.filter((r) => r.kind === "drill");
  return { source: rbPath, legit_rows: legit.length, false_latches: legit.filter((r) => r.false_latch === "1").length,
    drills: drills.map((r) => ({ run: r.run_id, outcome: r.outcome, pause_u_s: n(r.pause_u_s), pause_b_s: n(r.pause_b_s), resume_u_s: n(r.resume_u_s), block_ts_u_s: bt[r.run_id]?.u, block_ts_b_s: bt[r.run_id]?.b })) };
})() : null;
// Recovery distribution: successful recoveries only (a failed or timed-out recovery has no honest duration)
const recOk = (r: Record<string, string>) => (hasRecovery ? r.recovery === "ok" : r.resume_u_seen_ms !== "" && r.resume_b_seen_ms !== "");
const recRows = okAttacks.filter(recOk), recLeftOut = okAttacks.length - recRows.length;
// Burst: what scripts/burst-verify.ts proved about each stopping copycat (evidence/<instance>-burst-verify.csv)
const bvPath = path.replace(/-bench-runs\.csv$/, "-burst-verify.csv");
const bv = existsSync(bvPath) ? (() => {
  const [h, ...ls] = readFileSync(bvPath, "utf8").split("\n").filter(Boolean), hc = parseCsvLine(h);
  const ids = new Set(burst.map((r) => r.run_id)); // headline bursts only (bu-021..025 are the control arm)
  const rs = (ls.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [hc[i], v]))) as Record<string, string>[]).filter((r) => ids.has(r.run_id));
  return { source: bvPath, rows: rs.length, after: rs.filter((r) => r.reverted_after_pause === "1").length, paused_event_ok: rs.filter((r) => r.paused_event_ok === "1").length, reason_gatepaused: rs.filter((r) => r.reason === "GatePaused").length };
})() : null;
const summary = {
  source: path,
  runs: Object.fromEntries(["legit_strict", "legit_forced", "attack_forged", "attack_plausible", "burst"].map((k) => [k, { rows: of(k).length, ok: of(k).filter((r) => r.outcome === "ok").length, timeout: of(k).filter((r) => r.outcome === "timeout").length, error: of(k).filter((r) => r.outcome === "error").length, other: of(k).filter((r) => !["ok", "timeout", "error"].includes(r.outcome)).length }])),
  poll_ms: q(rows.map((r) => n(r.poll_ms))).max,
  latency_from_mint_mined: { all_attacks: lat(okAttacks, "mint_mined_ms"), forged: lat(okAttacks.filter((r) => r.kind === "attack_forged"), "mint_mined_ms"), plausible: lat(okAttacks.filter((r) => r.kind === "attack_plausible"), "mint_mined_ms"), burst: lat(burst.filter((r) => r.outcome === "ok"), "mint_mined_ms") },
  latency_from_mint_sent: lat(okAttacks, "mint_sent_ms"),
  block_timestamp_pause_gate_u_s: q(okAttacks.map((r) => n(r.gate_u_block_ts) - n(r.mint_block_ts))),
  // cross-chain legs compare two sequencers' whole-second clocks (Unichain mint block vs Base gate block); Lasna's own block
  // timestamps run up to 1 s behind the origin block (mint -> react deltas are -1..0 s), so no Lasna leg is published
  block_timestamp_pause_gate_b_s: q(okAttacks.map((r) => n(r.gate_b_block_ts) - n(r.mint_block_ts))),
  block_timestamp_both_gates_s: q(okAttacks.map((r) => Math.max(n(r.gate_b_block_ts), n(r.gate_u_block_ts)) - n(r.mint_block_ts))),
  false_positives: {
    legit_strict_runs: strict.length, legit_strict_false_pauses: strict.filter((r) => r.false_pause === "1").length,
    forced_runs: forced.length, forced_pause_seconds: q(forced.map((r) => n(r.pause_seconds))),
    forced_not_completed: forced.filter((r) => r.outcome !== "ok").length,
    forced_no_duration: forced.filter((r) => r.pause_seconds === "").map((r) => r.run_id), // e.g. `observer order inverted` (resume seen before pause)
  },
  strict_lasna_booking_s: q(ms(strict.map((r) => sec(r, "lasna_seen_ms", "mint_mined_ms")))),
  exposure_burst: {
    runs: burst.length, censored: burst.filter((r) => r.outcome === "censored").length,
    copycats_landed: q(burst.map((r) => n(r.copycats_landed))), copycats_fired: q(burst.map((r) => n(r.copycats_fired))),
    exposure_tusd: q(burst.map((r) => n(r.exposure_tusd))),
    carry_home_reverted: burst.filter((r) => /fail|revert|error/i.test(r.carry_home_status)).length, carry_home_rows: burst.filter((r) => r.carry_home_status !== "").length,
  },
  excluded_rows: excluded, control_arm_bursts: allBurst.filter((r) => Number(r.seq) > 20).map((r) => r.run_id),
  recovery_s: q(recRows.map((r) => n(r.recovery_ms) / 1000)),
  recovery_attack_rows_left_out: recLeftOut,
  burst_verify: bv,
  recovery_failed: recoveryFailed,
  route_b: rb,
};
(summary.exposure_burst as Record<string, unknown>).stopped_at_revert = burst.filter((r) => r.reverted_tx !== "").length;
(summary.exposure_burst as Record<string, unknown>).reached_cap = burst.filter((r) => r.reverted_tx === "").length;
(summary.exposure_burst as Record<string, unknown>).copycat_cap = 30;
const base = path.replace(/-bench-runs\.csv$/, "");
writeFileSync(`${base}-bench-summary.json`, JSON.stringify(summary, null, 2) + "\n");
const f = (x: { n: number; p50: number; p95: number; max: number }) => `n=${x.n} p50 ${x.p50} s · p95 ${x.p95} s · max ${x.max} s`;
const L = summary.latency_from_mint_mined.all_attacks, eb = summary.exposure_burst as typeof summary.exposure_burst & { stopped_at_revert: number; reached_cap: number; copycat_cap: number };
writeFileSync(`${base}-bench-summary.md`, [
  `# Bench summary (generated by scripts/bench-summary.ts from ${path}; do not edit)`, "",
  `- headline attack runs measured (forged ${okAttacks.filter((r) => r.kind === "attack_forged").length} + plausible ${okAttacks.filter((r) => r.kind === "attack_plausible").length} + burst ${okAttacks.filter((r) => r.kind === "burst").length}): ${okAttacks.length}; rows excluded: ${excluded.map((e) => e.run + " (" + e.outcome + ")").join(", ") || "none"}; bu-021..025 belong to the paired control`,
  `- clock: latencies are this machine's wall clock when a poll returned (poll every ${summary.poll_ms} ms, plus RPC latency); the same-chain block-timestamp line below is the on-chain cross-check`,
  `- detection (mint mined → Lasna react seen): ${f(L.detection_s)}`,
  `- pause, Unichain gate: ${f(L.pause_gate_u_s)}`,
  `- pause, Base gate: ${f(L.pause_gate_b_s)}`,
  `- both gates shut: ${f(L.pause_both_s)}`,
  `- false pauses on strict legit: ${summary.false_positives.legit_strict_false_pauses} of ${strict.length}`,
  `- forced fill-before-deposit pause seconds: ${f(summary.false_positives.forced_pause_seconds)}${summary.false_positives.forced_no_duration.length ? ` (${summary.false_positives.forced_no_duration.length} of ${forced.length} left out, no duration: ${summary.false_positives.forced_no_duration.join(", ")}; see the row note)` : ""}`,
  `- same-chain check, whole-second Unichain block timestamps (mint block → gate U Paused block): ${f(summary.block_timestamp_pause_gate_u_s)}`,
  `- cross-chain sequencer clocks, whole seconds (Unichain mint block → Base gate B Paused block): ${f(summary.block_timestamp_pause_gate_b_s)}; both gates shut (the later of the two Paused blocks): ${f(summary.block_timestamp_both_gates_s)}; two sequencers' clocks, so allow about ±1 s (Lasna blocks are stamped up to 1 s before their origin block, so no mint → react leg is given)`,
  `- recovery (seize + resolve + both gates reopened): ${f(summary.recovery_s)} (successful recoveries only; ${recLeftOut} of ${okAttacks.length} attack rows left out: ${hasRecovery ? "recovery not ok" : "a gate resume was not observed"})${recoveryFailed ? `; recovery failures: ${recoveryFailed.length}${recoveryFailed.length ? " (" + recoveryFailed.join(", ") + ")" : ""}` : ""}`,
  `- burst exposure: ${eb.runs} runs: ${eb.reached_cap === 0 ? "every run" : eb.stopped_at_revert + " of them"} stopped before the ${eb.copycat_cap}-copycat cap (${eb.reached_cap} reached the cap)${bv ? `; ${bv.after}/${bv.rows} stopped at the first reverted copycat mined after the gate U Paused tx (burst-verify: ${bv.after}/${bv.rows}; gate U receipt holds this run's Paused event ${bv.paused_event_ok}/${bv.rows})${bv.reason_gatepaused > 0 ? `; replaying the stopping copycat at its block reverts GatePaused ${bv.reason_gatepaused}/${bv.rows}` : "; revert reason not confirmed (historical eth_call unavailable)"}` : ""}; copycats landed p50 ${eb.copycats_landed.p50} · p95 ${eb.copycats_landed.p95} · max ${eb.copycats_landed.max}`,
  `- burst carry-home release on Base: reverted ${eb.carry_home_reverted} of ${eb.carry_home_rows} rows`,
  `- paired control (bu-021..025 guarded vs scripts/control.ts unguarded): the unguarded arm fires a fixed 6 copycats, the guarded burst fires up to ${eb.copycat_cap} and stops at the first revert, so issuance is an illustration, not a like-for-like rate`,
  ...(rb ? ["", "## Route B (operator drill (DrillBeacon), self-delivered Hyperlane route (our own Mailbox.process))", "",
    `- source: ${rb.source} (route B is guarded by the \`${ROUTE_B_INSTANCE}\` reactive contract)`,
    `- legit transfers: ${rb.legit_rows} rows, ${rb.false_latches} false latches`,
    ...rb.drills.map((d) => `- drill ${d.run} (${d.outcome}): observer wall-clock pause latency Unichain gate ${d.pause_u_s} s, Base gate ${d.pause_b_s} s (DrillBeacon.fire() receipt seen -> the poll that saw the gate Paused event)${d.block_ts_u_s !== undefined ? `; block-timestamp delta (fire tx block on Base -> gate Paused tx block): Unichain ${d.block_ts_u_s} s, Base ${d.block_ts_b_s} s` : ""}; resume (Unichain) ${d.resume_u_s} s after resolve()`)] : []),
  "",
].join("\n"));
console.log(JSON.stringify({ attacks: okAttacks.length, detection: L.detection_s, pause_both: L.pause_both_s, strict_false: summary.false_positives.legit_strict_false_pauses }));
