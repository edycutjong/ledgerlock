import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AbiEvent, PublicClient } from "viem";

// No RPC: client() is replaced by a per-chain fake whose head and logs each test scripts.
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chains.ts")>()),
  client: vi.fn(),
}));

import { client } from "./chains.ts";
import { observe, percentile, type LegWatch } from "./latency.ts";
import type { Hex } from "./triples.ts";

type FakeLog = { blockNumber: bigint; transactionHash: Hex; args?: Record<string, unknown> };

interface FakeChain {
  head: bigint;
  /** logs that exist on chain; getLogs returns those inside the queried range */
  logs: FakeLog[];
  /** called on every getBlockNumber, after the head is read (lets a test move the clock or the head) */
  onHead?: (n: number) => void;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
}

function fakeChain(head: bigint, logs: FakeLog[] = []): FakeChain {
  const fc: FakeChain = {
    head,
    logs,
    getBlockNumber: vi.fn(async () => {
      const h = fc.head;
      fc.onHead?.(fc.getBlockNumber.mock.calls.length);
      return h;
    }),
    getLogs: vi.fn(async (q: { fromBlock: bigint; toBlock: bigint }) =>
      fc.logs.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)),
  };
  return fc;
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
afterEach(() => {
  vi.useRealTimers();
});

const REACTIVE = 5318007;
const DEST = 84532;
const EVENT = { type: "event", name: "Sync", inputs: [] } as const satisfies AbiEvent;
const watch = (chainId: number, seq: bigint): LegWatch => ({
  chainId,
  address: "0x00000000000000000000000000000000000000bb",
  event: EVENT,
  match: (log) => log.args?.seq === seq,
});
const ranges = (fc: FakeChain) => fc.getLogs.mock.calls.map((c) => [c[0].fromBlock, c[0].toBlock]);

describe("observe", () => {
  test("observe captures both start blocks before send, so a leg mined during send is not missed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const order: string[] = [];
    chains[REACTIVE] = fakeChain(100n, [{ blockNumber: 101n, transactionHash: "0xreact", args: { seq: 7n } }]);
    chains[DEST] = fakeChain(50n, [{ blockNumber: 51n, transactionHash: "0xcallback", args: { seq: 7n } }]);
    chains[REACTIVE].onHead = () => order.push("reactive head");
    chains[DEST].onHead = () => order.push("callback head");
    chains[REACTIVE].getLogs.mockImplementationOnce(async (q) => {
      vi.setSystemTime(Date.now() + 700); // reactive log first observed 700 ms after mining
      return chains[REACTIVE].logs.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
    });
    chains[DEST].getLogs.mockImplementationOnce(async (q) => {
      vi.setSystemTime(Date.now() + 300);
      return chains[DEST].logs.filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock);
    });

    const s = await observe({
      send: async () => {
        order.push("send");
        chains[REACTIVE].head = 101n; // both legs land while send() is still waiting for the origin receipt
        chains[DEST].head = 51n;
        vi.setSystemTime(Date.now() + 1_500);
        return "0xorigin";
      },
      reactive: watch(REACTIVE, 7n),
      callback: watch(DEST, 7n),
      pollMs: 250,
      timeoutMs: 10_000,
    });

    expect(order.slice(0, 3)).toEqual(["reactive head", "callback head", "send"]);
    expect(ranges(chains[REACTIVE])).toEqual([[100n, 101n]]);
    expect(ranges(chains[DEST])).toEqual([[50n, 51n]]);
    expect(s).toEqual({
      originTx: "0xorigin",
      sentAtMs: 1_000_000,
      originMinedAtMs: 1_001_500,
      reactiveSeenAtMs: 1_002_200,
      callbackSeenAtMs: 1_002_500,
      reactiveTx: "0xreact",
      callbackTx: "0xcallback",
      pollMs: 250,
    });
  });

  test("observe passes the watched address and event to getLogs", async () => {
    chains[REACTIVE] = fakeChain(1n, [{ blockNumber: 1n, transactionHash: "0xr", args: { seq: 1n } }]);
    await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 1n), pollMs: 1 });
    expect(chains[REACTIVE].getLogs).toHaveBeenCalledWith({
      address: "0x00000000000000000000000000000000000000bb", event: EVENT, fromBlock: 1n, toBlock: 1n,
    });
  });

  test("observe skips a head that has not advanced and resumes the next scan at head+1 without rescanning", async () => {
    chains[REACTIVE] = fakeChain(10n, [
      { blockNumber: 10n, transactionHash: "0xother", args: { seq: 1n } },
      { blockNumber: 12n, transactionHash: "0xother2", args: { seq: 1n } },
      { blockNumber: 12n, transactionHash: "0xhit", args: { seq: 2n } },
      { blockNumber: 12n, transactionHash: "0xlater", args: { seq: 2n } },
    ]);
    // head reads: 10 (start), 10 (scan 10..10), 10 (stalled: no scan), 12 (scan 11..12)
    chains[REACTIVE].onHead = (n) => { if (n === 3) chains[REACTIVE].head = 12n; };

    const s = await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 2n), pollMs: 1 });

    expect(chains[REACTIVE].getBlockNumber).toHaveBeenCalledTimes(4);
    expect(ranges(chains[REACTIVE])).toEqual([[10n, 10n], [11n, 12n]]);
    expect(s.reactiveTx, "the first matching log wins; non-matching logs are ignored").toBe("0xhit");
  });

  test("observe does not watch the callback leg when the reactive leg is never seen", async () => {
    chains[REACTIVE] = fakeChain(5n);
    chains[DEST] = fakeChain(9n, [{ blockNumber: 9n, transactionHash: "0xcb", args: { seq: 3n } }]);
    const send = vi.fn(async (): Promise<Hex> => "0xo");

    const s = await observe({ send, reactive: watch(REACTIVE, 3n), callback: watch(DEST, 3n), timeoutMs: 0, pollMs: 1 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(chains[DEST].getBlockNumber, "the callback start block is still captured before send").toHaveBeenCalledTimes(1);
    expect(chains[DEST].getLogs).not.toHaveBeenCalled();
    expect(vi.mocked(client).mock.calls.filter(([id]) => id === DEST), "the callback chain is touched once, for its start block only")
      .toHaveLength(1);
    expect(s).toMatchObject({ originTx: "0xo", reactiveSeenAtMs: null, reactiveTx: null, callbackSeenAtMs: null, callbackTx: null });
  });

  test("observe gives up on a stalled reactive leg at the deadline and scans the stalled head only once", async () => {
    chains[REACTIVE] = fakeChain(5n);
    const s = await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 1n), timeoutMs: 120, pollMs: 2 });
    expect(s.reactiveSeenAtMs).toBeNull();
    expect(s.reactiveTx).toBeNull();
    expect(chains[REACTIVE].getBlockNumber.mock.calls.length).toBeGreaterThan(2);
    expect(ranges(chains[REACTIVE])).toEqual([[5n, 5n]]);
  });

  test("observe reports a missing callback leg as null when it times out after the reactive leg is seen", async () => {
    chains[REACTIVE] = fakeChain(1n, [{ blockNumber: 1n, transactionHash: "0xr", args: { seq: 4n } }]);
    chains[DEST] = fakeChain(1n, [{ blockNumber: 1n, transactionHash: "0xwrong", args: { seq: 5n } }]);
    const s = await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 4n), callback: watch(DEST, 4n), timeoutMs: 100, pollMs: 2 });
    expect(s.reactiveTx).toBe("0xr");
    expect(s.reactiveSeenAtMs).toEqual(expect.any(Number));
    expect(s.callbackTx).toBeNull();
    expect(s.callbackSeenAtMs).toBeNull();
    expect(chains[DEST].getLogs).toHaveBeenCalled();
  });

  test("observe without a callback leg never touches a callback chain and reports the default 500 ms poll", async () => {
    chains[REACTIVE] = fakeChain(3n, [{ blockNumber: 3n, transactionHash: "0xr", args: { seq: 1n } }]);
    const s = await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 1n) });
    expect(vi.mocked(client).mock.calls.every(([id]) => id === REACTIVE)).toBe(true);
    expect(s).toMatchObject({ reactiveTx: "0xr", callbackSeenAtMs: null, callbackTx: null, pollMs: 500 });
  });

  test("observe defaults to a 180 s deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    chains[REACTIVE] = fakeChain(1n);
    // every poll after the start-block read costs 100 s of wall clock: polls start at t=0 and t=100 s; t=200 s is past 180 s
    chains[REACTIVE].onHead = (n) => { if (n > 1) vi.setSystemTime(Date.now() + 100_000); };
    const s = await observe({ send: async () => "0xo", reactive: watch(REACTIVE, 1n), pollMs: 1 });
    expect(chains[REACTIVE].getBlockNumber).toHaveBeenCalledTimes(3); // start + 2 polls
    expect(s.reactiveSeenAtMs).toBeNull();
  });

  test("observe sleeps pollMs between polls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    chains[REACTIVE] = fakeChain(1n, [{ blockNumber: 2n, transactionHash: "0xr", args: { seq: 1n } }]);
    const p = observe({ send: async () => "0xo", reactive: watch(REACTIVE, 1n), pollMs: 400 });
    await vi.advanceTimersByTimeAsync(0);
    expect(chains[REACTIVE].getBlockNumber).toHaveBeenCalledTimes(2); // start + first poll (no hit yet)
    chains[REACTIVE].head = 2n;
    await vi.advanceTimersByTimeAsync(399);
    expect(chains[REACTIVE].getBlockNumber).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ reactiveTx: "0xr", pollMs: 400 });
    expect(chains[REACTIVE].getBlockNumber).toHaveBeenCalledTimes(3);
  });

  test("observe propagates a failed send and never starts watching", async () => {
    chains[REACTIVE] = fakeChain(1n);
    await expect(observe({ send: async () => { throw new Error("nonce too low"); }, reactive: watch(REACTIVE, 1n) }))
      .rejects.toThrow("nonce too low");
    expect(chains[REACTIVE].getLogs).not.toHaveBeenCalled();
  });
});

describe("percentile", () => {
  test("percentile is nearest-rank with no interpolation", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 91)).toBe(10);
    expect(percentile([10, 20], 50)).toBe(10);
  });

  test("percentile ignores NaN and infinite samples (failed runs are not ranked)", () => {
    expect(percentile([Number.NaN, 3, Infinity, 1, -Infinity, 2], 50)).toBe(2);
    expect(percentile([Number.NaN, 3, Infinity, 1, -Infinity, 2], 100)).toBe(3);
  });

  test("percentile of only non-finite samples is NaN", () => {
    expect(percentile([Number.NaN, Infinity], 50)).toBeNaN();
  });

  test("percentile at p0 clamps to the smallest observed value", () => {
    expect(percentile([4, 2, 9], 0)).toBe(2);
  });

  test("percentile sorts numerically, not lexicographically", () => {
    expect(percentile([100, 9, 20], 50)).toBe(20);
  });

  test("percentile does not reorder the caller's array", () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});
