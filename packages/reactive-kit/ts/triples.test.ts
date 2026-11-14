import { beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AbiEvent, PublicClient } from "viem";

// No RPC: client() is replaced by a per-chain fake; the chain registry (logSpan etc.) stays real.
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chains.ts")>()),
  client: vi.fn(),
}));

import { client } from "./chains.ts";
import {
  appendTriples,
  blockTs,
  buildTriple,
  getLogsChunked,
  hopSeconds,
  parseCsvLine,
  readTriples,
  rowKey,
  toCsvLine,
  TRIPLE_COLUMNS,
  txInfo,
  type Hex,
  type TripleRow,
} from "./triples.ts";

const row = (o: Partial<TripleRow>): TripleRow =>
  Object.fromEntries(TRIPLE_COLUMNS.map((c) => [c, o[c] ?? ""])) as TripleRow;
const tmpCsv = () => join(mkdtempSync(join(tmpdir(), "kit-triples-")), "t.csv");

// ---- fake chain: blocks with timestamps, receipts, a head, and getLogs that records its ranges ----

interface FakeChain {
  getBlock: ReturnType<typeof vi.fn>;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
}

function fakeChain(o: { head?: bigint; blocks?: Record<string, bigint>; receipts?: Record<string, { blockNumber: bigint; status: string }> } = {}): FakeChain {
  return {
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
      const ts = o.blocks?.[String(blockNumber)];
      if (ts === undefined) throw new Error(`no block ${blockNumber}`);
      return { timestamp: ts };
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const r = o.receipts?.[hash];
      if (!r) throw new Error(`no receipt ${hash}`);
      return r;
    }),
    getBlockNumber: vi.fn(async () => o.head ?? 0n),
    getLogs: vi.fn(async (q: { fromBlock: bigint; toBlock: bigint }) => [{ blockNumber: q.fromBlock, range: [q.fromBlock, q.toBlock] }]),
  };
}

let chains: Record<number, FakeChain>;
beforeEach(() => {
  chains = {};
  vi.mocked(client).mockReset();
  vi.mocked(client).mockImplementation((id: number) => {
    const c = chains[id];
    if (!c) throw new Error(`test did not set up chain ${id}`);
    return c as unknown as PublicClient;
  });
});

const EVENT = { type: "event", name: "Ack", inputs: [] } as const satisfies AbiEvent;
const ADDR: Hex = "0x00000000000000000000000000000000000000aa";

// ---------------------------------------------------------------------------------------------------------------

describe("blockTs / txInfo", () => {
  test("blockTs returns the block timestamp as unix seconds (number, not bigint)", async () => {
    chains[84532] = fakeChain({ blocks: { "100": 1_731_000_000n } });
    await expect(blockTs(84532, 100n)).resolves.toBe(1_731_000_000);
    expect(chains[84532].getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
  });

  test("blockTs fetches each (chain, block) once and serves repeats from the cache", async () => {
    chains[84532] = fakeChain({ blocks: { "200": 50n } });
    await blockTs(84532, 200n);
    await expect(blockTs(84532, 200n)).resolves.toBe(50);
    expect(chains[84532].getBlock).toHaveBeenCalledTimes(1);
  });

  test("blockTs caches a zero timestamp instead of refetching it", async () => {
    chains[84532] = fakeChain({ blocks: { "300": 0n } });
    await blockTs(84532, 300n);
    await expect(blockTs(84532, 300n)).resolves.toBe(0);
    expect(chains[84532].getBlock).toHaveBeenCalledTimes(1);
  });

  test("blockTs keys the cache by chain, so the same block number on another chain is fetched separately", async () => {
    chains[84532] = fakeChain({ blocks: { "400": 10n } });
    chains[1301] = fakeChain({ blocks: { "400": 20n } });
    await expect(blockTs(84532, 400n)).resolves.toBe(10);
    await expect(blockTs(1301, 400n)).resolves.toBe(20);
  });

  test("txInfo returns the receipt's block, that block's timestamp, and the receipt status", async () => {
    chains[1301] = fakeChain({ blocks: { "7": 1_000n }, receipts: { "0xabc": { blockNumber: 7n, status: "reverted" } } });
    await expect(txInfo(1301, "0xabc")).resolves.toEqual({ block: 7n, ts: 1_000, status: "reverted" });
    expect(chains[1301].getTransactionReceipt).toHaveBeenCalledWith({ hash: "0xabc" });
  });
});

describe("getLogsChunked", () => {
  test("getLogsChunked splits the range into the chain's logSpan, inclusive and without gaps or overlap", async () => {
    chains[84532] = fakeChain(); // Base Sepolia: logSpan 180
    const args = { seq: 4n };
    const logs = await getLogsChunked(84532, { address: ADDR, event: EVENT, fromBlock: 0n, toBlock: 400n, args });
    expect(chains[84532].getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock])).toEqual([
      [0n, 180n],
      [181n, 361n],
      [362n, 400n],
    ]);
    expect(chains[84532].getLogs).toHaveBeenCalledWith({ address: ADDR, event: EVENT, args, fromBlock: 0n, toBlock: 180n });
    expect(chains[84532].getBlockNumber).not.toHaveBeenCalled();
    expect(logs, "logs of every chunk are concatenated in block order").toHaveLength(3);
  });

  test("getLogsChunked reads up to the current head when toBlock is omitted", async () => {
    chains[1301] = fakeChain({ head: 2_500n }); // Unichain Sepolia: logSpan 2000
    await getLogsChunked(1301, { address: ADDR, event: EVENT, fromBlock: 100n });
    expect(chains[1301].getBlockNumber).toHaveBeenCalledTimes(1);
    expect(chains[1301].getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock])).toEqual([
      [100n, 2_100n],
      [2_101n, 2_500n],
    ]);
  });

  test("getLogsChunked issues a single call when the range fits exactly in one span", async () => {
    chains[84532] = fakeChain();
    await getLogsChunked(84532, { address: ADDR, event: EVENT, fromBlock: 1_000n, toBlock: 1_180n });
    expect(chains[84532].getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock])).toEqual([[1_000n, 1_180n]]);
  });

  test("getLogsChunked queries nothing and returns no logs when fromBlock is past toBlock", async () => {
    chains[84532] = fakeChain();
    await expect(getLogsChunked(84532, { address: ADDR, event: EVENT, fromBlock: 10n, toBlock: 9n })).resolves.toEqual([]);
    expect(chains[84532].getLogs).not.toHaveBeenCalled();
  });

  test("getLogsChunked rejects an unknown chain before querying", async () => {
    chains[999] = fakeChain();
    await expect(getLogsChunked(999, { address: ADDR, event: EVENT, fromBlock: 0n, toBlock: 1n })).rejects.toThrow("unknown chain 999");
    expect(chains[999].getLogs).not.toHaveBeenCalled();
  });
});

describe("buildTriple", () => {
  test("buildTriple fills every column from on-chain timestamps for a full origin -> reactive -> callback triple", async () => {
    chains[11155111] = fakeChain({ blocks: { "10": 1_000n }, receipts: { "0x01": { blockNumber: 10n, status: "success" } } });
    chains[5318007] = fakeChain({ blocks: { "20": 1_004n }, receipts: { "0x02": { blockNumber: 20n, status: "success" } } });
    chains[84532] = fakeChain({ blocks: { "30": 1_009n }, receipts: { "0x03": { blockNumber: 30n, status: "success" } } });
    const r = await buildTriple({
      stage: "GRACE", seq: 7n, triggerKind: "origin_log", triggerChain: 11155111, triggerTx: "0x01",
      reactiveChain: 5318007, reactiveTx: "0x02", callback: { chainId: 84532, tx: "0x03" },
      lastActivity: { chainId: 1301, tx: "0x04" }, instance: "demo", note: "ok, fine",
    });
    expect(r).toEqual({
      stage: "GRACE", seq: "7", trigger_kind: "origin_log", trigger_chain: "11155111", trigger_tx: "0x01",
      trigger_ts: "1000", reactive_tx: "0x02", reactive_ts: "1004", callback_chain: "84532", callback_tx: "0x03",
      callback_ts: "1009", last_activity_chain: "1301", last_activity_tx: "0x04", instance: "demo", note: "ok, fine",
    });
    expect(Object.keys(r), "row keys follow TRIPLE_COLUMNS order").toEqual([...TRIPLE_COLUMNS]);
    expect(chains[1301], "lastActivity is recorded as given, not fetched").toBeUndefined();
  });

  test("buildTriple leaves callback, last-activity and note cells empty when those legs are absent", async () => {
    chains[5318007] = fakeChain({
      blocks: { "5": 500n, "6": 503n },
      receipts: { "0xc1": { blockNumber: 5n, status: "success" }, "0xc2": { blockNumber: 6n, status: "success" } },
    });
    const r = await buildTriple({
      stage: "CRON", seq: 3, triggerKind: "cron", triggerChain: 5318007, triggerTx: "0xc1",
      reactiveChain: 5318007, reactiveTx: "0xc2", instance: "demo",
    });
    expect(r).toMatchObject({
      seq: "3", trigger_kind: "cron", trigger_ts: "500", reactive_ts: "503",
      callback_chain: "", callback_tx: "", callback_ts: "", last_activity_chain: "", last_activity_tx: "", note: "",
    });
    expect(hopSeconds(r).triggerToReactive).toBe(3);
  });
});

describe("CSV encoding", () => {
  test("toCsvLine emits cells in TRIPLE_COLUMNS order and leaves plain values unquoted", () => {
    const r = row({ stage: "S", seq: "1", trigger_tx: "0xA", instance: "i", note: "plain" });
    expect(toCsvLine(r)).toBe("S,1,,,0xA,,,,,,,,,i,plain");
  });

  test("toCsvLine quotes a cell containing a comma, a quote, or a newline and doubles embedded quotes", () => {
    const line = toCsvLine(row({ note: 'say "hi"' }));
    expect(line.endsWith(',"say ""hi"""')).toBe(true);
    expect(toCsvLine(row({ note: "a,b" })).endsWith(',"a,b"')).toBe(true);
    expect(toCsvLine(row({ note: "a\nb" })).endsWith(',"a\nb"')).toBe(true);
  });

  test("toCsvLine writes a column missing from the row object as an empty cell", () => {
    const partial = { stage: "S", note: "n" } as unknown as TripleRow;
    expect(toCsvLine(partial)).toBe(`S${",".repeat(TRIPLE_COLUMNS.length - 2)},n`);
  });

  test("parseCsvLine keeps empty fields, including leading and trailing ones", () => {
    expect(parseCsvLine(",a,,b,")).toEqual(["", "a", "", "b", ""]);
    expect(parseCsvLine("")).toEqual([""]);
  });

  test("parseCsvLine unescapes doubled quotes inside a quoted field and keeps commas there", () => {
    expect(parseCsvLine('x,"a ""q"", b",y')).toEqual(["x", 'a "q", b', "y"]);
    expect(parseCsvLine('"",z')).toEqual(["", "z"]);
  });
});

describe("readTriples", () => {
  test("readTriples returns no rows for a file that does not exist", () => {
    expect(readTriples(join(mkdtempSync(join(tmpdir(), "kit-triples-")), "missing.csv"))).toEqual([]);
  });

  test("readTriples maps cells by the file's own header, not by TRIPLE_COLUMNS order", () => {
    const p = tmpCsv();
    writeFileSync(p, "seq,stage,reactive_tx\n9,GRACE,0xR\n");
    expect(readTriples(p)).toEqual([{ seq: "9", stage: "GRACE", reactive_tx: "0xR" }]);
  });

  test("readTriples skips blank and whitespace-only lines", () => {
    const p = tmpCsv();
    writeFileSync(p, "\nstage,seq\n\nA,1\n   \nB,2\n\n");
    expect(readTriples(p).map((r) => r.stage)).toEqual(["A", "B"]);
  });

  test("readTriples fills cells a short line lacks with empty strings", () => {
    const p = tmpCsv();
    writeFileSync(p, "stage,seq,note\nA\n");
    expect(readTriples(p)).toEqual([{ stage: "A", seq: "", note: "" }]);
  });
});

describe("rowKey", () => {
  test("rowKey is (instance, stage, seq, reactive tx) with the reactive tx case-folded", () => {
    expect(rowKey(row({ instance: "demo", stage: "GRACE", seq: "1", reactive_tx: "0xABcd" }))).toBe("demo|GRACE|1|0xabcd");
  });

  test("rowKey ignores the trigger, so a re-join with a better trigger maps to the same row", () => {
    const a = row({ instance: "d", stage: "S", seq: "1", reactive_tx: "0xR", trigger_tx: "0xA" });
    expect(rowKey({ ...a, trigger_tx: "0xB", trigger_ts: "5" })).toBe(rowKey(a));
  });
});

describe("appendTriples", () => {
  const base = { stage: "CANCEL", seq: "4", reactive_tx: "0xR4", instance: "demo" };

  test("appendTriples creates the file with the TRIPLE_COLUMNS header and returns the number of rows added", () => {
    const p = tmpCsv();
    expect(appendTriples(p, [row({ ...base, seq: "1" }), row({ ...base, seq: "2" })])).toBe(2);
    const lines = readFileSync(p, "utf8").split("\n");
    expect(lines[0]).toBe(TRIPLE_COLUMNS.join(","));
    expect(lines).toHaveLength(4); // header, 2 rows, trailing newline
    expect(lines[3]).toBe("");
  });

  test("appendTriples with no rows rewrites an existing file unchanged and adds nothing", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, note: "a, b" })]);
    const before = readFileSync(p, "utf8");
    expect(appendTriples(p, [])).toBe(0);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  test("appendTriples merges two rows for the same react within one batch instead of adding a twin", () => {
    const p = tmpCsv();
    const first = row({ ...base, trigger_tx: "0xA" });
    const added = appendTriples(p, [first, row({ ...base, reactive_tx: "0XR4", trigger_tx: "0xB" })]);
    expect(added).toBe(1);
    const rows = readTriples(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_tx).toBe("0xB");
    expect(rowKey(rows[0])).toBe(rowKey(first));
  });

  test("appendTriples keeps rows that a later run does not re-join (history survives log pruning)", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, seq: "1" }), row({ ...base, seq: "2" })]);
    appendTriples(p, [row({ ...base, seq: "3" })]);
    expect(readTriples(p).map((r) => r.seq)).toEqual(["1", "2", "3"]);
  });

  test("appendTriples keeps a callback leg a re-join missed", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_chain: "84532", callback_tx: "0xCB", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, note: "rejoined" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_chain: "84532", callback_tx: "0xCB", callback_ts: "200", note: "rejoined" });
  });

  test("appendTriples never blanks a stored field with a column the re-join row does not carry at all", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, trigger_tx: "0xA", note: "keep me" })]);
    const sparse = { ...base, trigger_tx: "0xB" } as unknown as TripleRow; // no note / callback keys
    expect(appendTriples(p, [sparse])).toBe(0);
    expect(readTriples(p)[0]).toMatchObject({ trigger_tx: "0xB", note: "keep me" });
  });

  test("appendTriples moves the callback leg as a unit: a later callback changes neither tx, ts nor chain", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_chain: "84532", callback_tx: "0xAPPLY", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, callback_chain: "1301", callback_tx: "0xLATE", callback_ts: "201" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_chain: "84532", callback_tx: "0xAPPLY", callback_ts: "200" });
    appendTriples(p, [row({ ...base, callback_chain: "1301", callback_tx: "0xEARLY", callback_ts: "199" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_chain: "1301", callback_tx: "0xEARLY", callback_ts: "199" });
  });

  test("appendTriples keeps the stored callback when the re-join's callback has the same timestamp", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_tx: "0xFIRST", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, callback_tx: "0xTIE", callback_ts: "200" })]);
    expect(readTriples(p)[0].callback_tx).toBe("0xFIRST");
  });

  test("appendTriples does not treat a re-join callback with no timestamp as earlier (empty is not block 0)", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_tx: "0xTIMED", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, callback_tx: "0xUNTIMED", callback_ts: "" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_tx: "0xTIMED", callback_ts: "200" });
  });

  test("appendTriples keeps a stored callback that has no timestamp and never grafts another callback's timestamp onto it", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_tx: "0xUNTIMED", callback_ts: "" })]);
    appendTriples(p, [row({ ...base, callback_tx: "0xTIMED", callback_ts: "5" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_tx: "0xUNTIMED", callback_ts: "" });
    // Number("") is 0, so only a timestamp below 0 would look "earlier" than the blank one if it were compared at all.
    appendTriples(p, [row({ ...base, callback_tx: "0xNEGATIVE", callback_ts: "-1" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_tx: "0xUNTIMED", callback_ts: "" });
  });

  test("appendTriples keeps the stored callback when either timestamp is not a number", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, callback_tx: "0xSTORED", callback_ts: "200" })]);
    appendTriples(p, [row({ ...base, callback_tx: "0xJUNK", callback_ts: "soon" })]);
    expect(readTriples(p)[0]).toMatchObject({ callback_tx: "0xSTORED", callback_ts: "200" });

    const q = tmpCsv();
    appendTriples(q, [row({ ...base, callback_tx: "0xJUNK", callback_ts: "n/a" })]);
    appendTriples(q, [row({ ...base, callback_tx: "0xNUM", callback_ts: "1" })]);
    expect(readTriples(q)[0]).toMatchObject({ callback_tx: "0xJUNK", callback_ts: "n/a" });
  });

  test("appendTriples round-trips quoted notes through the file without splitting the row", () => {
    const p = tmpCsv();
    appendTriples(p, [row({ ...base, note: 'replay "x", then apply' })]);
    appendTriples(p, [row({ ...base, seq: "5" })]);
    const rows = readTriples(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe('replay "x", then apply');
  });
});

describe("hopSeconds", () => {
  test("hopSeconds returns NaN for the callback hops when the callback block is missing, but keeps the reactive hop", () => {
    expect(hopSeconds(row({ trigger_ts: "10", reactive_ts: "14" }))).toEqual({ triggerToReactive: 4, reactiveToCallback: NaN, total: NaN });
  });

  test("hopSeconds reports a zero-second hop when the callback lands in a block with the reactive timestamp", () => {
    expect(hopSeconds(row({ trigger_ts: "10", reactive_ts: "12", callback_ts: "12" }))).toEqual({ triggerToReactive: 2, reactiveToCallback: 0, total: 2 });
  });
});
