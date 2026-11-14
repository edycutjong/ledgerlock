import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTriples, hopSeconds, parseCsvLine, readTriples, toCsvLine, TRIPLE_COLUMNS, type TripleRow } from "./triples.ts";
import { percentile } from "./latency.ts";
import { assertSameNetworkClass, chain } from "./chains.ts";

const row = (o: Partial<TripleRow>): TripleRow =>
  Object.fromEntries(TRIPLE_COLUMNS.map((c) => [c, o[c] ?? ""])) as TripleRow;

describe("reactive-kit (ported from node:test)", () => {
  test("csv round-trips notes with commas and quotes", () => {
    const r = row({ stage: "PROBE", seq: "1", note: 'a, "b", c' });
    expect(parseCsvLine(toCsvLine(r))).toEqual(TRIPLE_COLUMNS.map((c) => r[c]));
  });

  test("appendTriples upserts per (instance, stage, seq, reactive tx); a re-join fixes, never blanks, a row", () => {
    const p = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
    const a = row({ stage: "GRACE", seq: "1", trigger_tx: "0xAA", reactive_tx: "0xR1", instance: "demo", callback_tx: "0x01" });
    const rejoin = { ...a, reactive_tx: "0xr1", trigger_tx: "0xBB", callback_tx: "" };
    expect(appendTriples(p, [a])).toBe(1);
    expect(appendTriples(p, [rejoin, row({ stage: "GRACE", seq: "2", reactive_tx: "0xR2", instance: "demo" })])).toBe(1);
    const rows = readTriples(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].trigger_tx, "the corrected trigger replaces the stale one in place").toBe("0xBB");
    expect(rows[0].callback_tx, "a leg the re-join missed is kept").toBe("0x01");
    expect(readFileSync(p, "utf8").split("\n")[0]).toBe(TRIPLE_COLUMNS.join(","));
  });

  test("appendTriples: the callback leg is replaced only by an earlier callback (a replayed Ack never wins)", () => {
    const p = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
    const base = { stage: "CANCEL", seq: "4", reactive_tx: "0xR4", instance: "demo", callback_chain: "84532" };
    appendTriples(p, [row({ ...base, trigger_tx: "0xAA", callback_tx: "0xAPPLY", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, trigger_tx: "0xBB", callback_tx: "0xREPLAY", callback_ts: "260" })]);
    let r = readTriples(p)[0];
    expect(r.callback_tx, "a later (replay) Ack does not replace the applying one").toBe("0xAPPLY");
    expect(r.callback_ts).toBe("200");
    expect(r.trigger_tx, "non-callback fields still take the re-join").toBe("0xBB");
    appendTriples(p, [row({ ...base, callback_tx: "0xEARLIER", callback_ts: "150" })]);
    r = readTriples(p)[0];
    expect(r.callback_tx, "an earlier callback repairs a row that had locked in a replay").toBe("0xEARLIER");
    expect(r.callback_ts).toBe("150");
    const q = join(mkdtempSync(join(tmpdir(), "kit-")), "t.csv");
    appendTriples(q, [row({ ...base, callback_tx: "" })]);
    appendTriples(q, [row({ ...base, callback_tx: "0xFILL", callback_ts: "300" })]);
    expect(readTriples(q)[0].callback_tx, "a blank callback leg is filled").toBe("0xFILL");
  });

  test("hopSeconds and missing legs", () => {
    const h = hopSeconds(row({ trigger_ts: "100", reactive_ts: "101", callback_ts: "103" }));
    expect(h).toEqual({ triggerToReactive: 1, reactiveToCallback: 2, total: 3 });
    expect(hopSeconds(row({ trigger_ts: "1", reactive_ts: "2" })).total).toBeNaN();
  });

  test("percentile is nearest-rank (always an observed value)", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  test("chains: testnet and mainnet are never mixed", () => {
    expect(() => assertSameNetworkClass([5318007, 84532, 11155111, 1301])).not.toThrow();
    expect(() => assertSameNetworkClass([5318007, 8453])).toThrow();
    expect(chain(84532).logSpan).toBe(180n);
  });
});
