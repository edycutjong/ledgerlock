import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTriples, hopSeconds, parseCsvLine, readTriples, toCsvLine, TRIPLE_COLUMNS, type TripleRow } from "./triples.ts";
import { percentile } from "./latency.ts";
import { assertSameNetworkClass, chain } from "./chains.ts";

const row = (o: Partial<TripleRow>): TripleRow =>
  Object.fromEntries(TRIPLE_COLUMNS.map((c) => [c, o[c] ?? ""])) as TripleRow;

test("csv round-trips notes with commas and quotes", () => {
  const r = row({ stage: "PROBE", seq: "1", note: 'a, "b", c' });
  assert.deepEqual(parseCsvLine(toCsvLine(r)), TRIPLE_COLUMNS.map((c) => r[c]));
});

test("appendTriples upserts per (instance, stage, seq, reactive tx); a re-join fixes, never blanks, a row", () => {
  const p = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
  const a = row({ stage: "GRACE", seq: "1", trigger_tx: "0xAA", reactive_tx: "0xR1", instance: "demo", callback_tx: "0x01" });
  const rejoin = { ...a, reactive_tx: "0xr1", trigger_tx: "0xBB", callback_tx: "" };
  assert.equal(appendTriples(p, [a]), 1);
  assert.equal(appendTriples(p, [rejoin, row({ stage: "GRACE", seq: "2", reactive_tx: "0xR2", instance: "demo" })]), 1);
  const rows = readTriples(p);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trigger_tx, "0xBB", "the corrected trigger replaces the stale one in place");
  assert.equal(rows[0].callback_tx, "0x01", "a leg the re-join missed is kept");
  assert.equal(readFileSync(p, "utf8").split("\n")[0], TRIPLE_COLUMNS.join(","));
});

test("appendTriples: the callback leg is replaced only by an earlier callback (a replayed Ack never wins)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
  const base = { stage: "CANCEL", seq: "4", reactive_tx: "0xR4", instance: "demo", callback_chain: "84532" };
  appendTriples(p, [row({ ...base, trigger_tx: "0xAA", callback_tx: "0xAPPLY", callback_ts: "200" })]);
  appendTriples(p, [row({ ...base, trigger_tx: "0xBB", callback_tx: "0xREPLAY", callback_ts: "260" })]);
  let r = readTriples(p)[0];
  assert.equal(r.callback_tx, "0xAPPLY", "a later (replay) Ack does not replace the applying one");
  assert.equal(r.callback_ts, "200");
  assert.equal(r.trigger_tx, "0xBB", "non-callback fields still take the re-join");
  appendTriples(p, [row({ ...base, callback_tx: "0xEARLIER", callback_ts: "150" })]);
  r = readTriples(p)[0];
  assert.equal(r.callback_tx, "0xEARLIER", "an earlier callback repairs a row that had locked in a replay");
  assert.equal(r.callback_ts, "150");
  const q = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
  appendTriples(q, [row({ ...base, callback_tx: "" })]);
  appendTriples(q, [row({ ...base, callback_tx: "0xFILL", callback_ts: "300" })]);
  assert.equal(readTriples(q)[0].callback_tx, "0xFILL", "a blank callback leg is filled");
});

test("hopSeconds and missing legs", () => {
  const h = hopSeconds(row({ trigger_ts: "100", reactive_ts: "101", callback_ts: "103" }));
  assert.deepEqual(h, { triggerToReactive: 1, reactiveToCallback: 2, total: 3 });
  assert.ok(Number.isNaN(hopSeconds(row({ trigger_ts: "1", reactive_ts: "2" })).total));
});

test("percentile is nearest-rank (always an observed value)", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([7], 95), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("chains: testnet and mainnet are never mixed", () => {
  assert.doesNotThrow(() => assertSameNetworkClass([5318007, 84532, 11155111, 1301]));
  assert.throws(() => assertSameNetworkClass([5318007, 8453]));
  assert.equal(chain(84532).logSpan, 180n);
});
