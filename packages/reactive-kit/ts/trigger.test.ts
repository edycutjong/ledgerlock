import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";

// No RPC: client() is replaced by a fake whose waitForTransactionReceipt each test scripts.
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chains.ts")>()),
  client: vi.fn(),
}));

import { client } from "./chains.ts";
import { ORIGINS_HEADER, requireEnv, trigger } from "./trigger.ts";
import type { Hex } from "./triples.ts";

const waitForTransactionReceipt = vi.fn();
const tmpOut = () => join(mkdtempSync(join(tmpdir(), "kit-trigger-")), "origins.csv");

beforeEach(() => {
  waitForTransactionReceipt.mockReset();
  vi.mocked(client).mockReset();
  vi.mocked(client).mockReturnValue({ waitForTransactionReceipt } as unknown as PublicClient);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A receipt wait that takes `ms` of wall clock and returns the given block + status. */
const minedAfter = (ms: number, blockNumber: bigint, status = "success") =>
  waitForTransactionReceipt.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + ms);
    return { blockNumber, status };
  });

describe("requireEnv", () => {
  test("requireEnv returns the variable's value when it is set", () => {
    vi.stubEnv("LEDGERLOCK_TEST_KEY", "0xsecret");
    expect(requireEnv("LEDGERLOCK_TEST_KEY")).toBe("0xsecret");
  });

  test("requireEnv refuses to run when the variable is unset, naming it without echoing any value", () => {
    vi.stubEnv("LEDGERLOCK_TEST_KEY", undefined);
    expect(() => requireEnv("LEDGERLOCK_TEST_KEY")).toThrow(/^LEDGERLOCK_TEST_KEY is not set \(source it from ~\/\.config\/…; never commit it\)$/);
  });

  test("requireEnv treats an empty value as unset", () => {
    vi.stubEnv("LEDGERLOCK_TEST_KEY", "");
    expect(() => requireEnv("LEDGERLOCK_TEST_KEY")).toThrow("LEDGERLOCK_TEST_KEY is not set");
  });
});

describe("trigger", () => {
  test("trigger writes the origins header once and appends one row per origin tx in ORIGINS_HEADER column order", async () => {
    const out = tmpOut();
    minedAfter(2_000, 123n);
    const first = await trigger({
      chainId: 84532, kind: "deposit", instance: "demo", out,
      send: async () => { vi.setSystemTime(Date.now() + 400); return "0xaaa"; },
    });
    expect(first).toEqual({ tx: "0xaaa", block: 123n, sentAtMs: 1_700_000_000_000, minedAtMs: 1_700_000_002_400 });

    minedAfter(1_000, 124n);
    await trigger({ chainId: 84532, kind: "cancel", instance: "demo", out, send: async () => "0xbbb" });

    expect(readFileSync(out, "utf8")).toBe(
      [
        ORIGINS_HEADER,
        "84532,deposit,0xaaa,123,1700000000000,1700000002400,demo",
        "84532,cancel,0xbbb,124,1700000002400,1700000003400,demo",
        "",
      ].join("\n"),
    );
  });

  test("trigger keeps the origins header in the documented column order", () => {
    expect(ORIGINS_HEADER).toBe("chain_id,kind,origin_tx,block,sent_at_ms,mined_at_ms,instance");
  });

  test("trigger waits for the receipt of the hash send() returned, on the trigger chain, polling every 250 ms", async () => {
    const order: string[] = [];
    waitForTransactionReceipt.mockImplementationOnce(async (q: { hash: Hex }) => {
      order.push(`wait ${q.hash}`);
      return { blockNumber: 1n, status: "success" };
    });
    await trigger({
      chainId: 1301, kind: "k", instance: "i", out: tmpOut(),
      send: async () => { order.push("send"); return "0xfeed"; },
    });
    expect(order).toEqual(["send", "wait 0xfeed"]);
    expect(client).toHaveBeenCalledWith(1301);
    expect(waitForTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: "0xfeed", pollingInterval: 250 });
  });

  test("trigger appends to an existing origins file without rewriting its header or earlier rows", async () => {
    const out = tmpOut();
    writeFileSync(out, `${ORIGINS_HEADER}\n1301,old,0x01,9,1,2,prev\n`);
    minedAfter(0, 10n);
    await trigger({ chainId: 1301, kind: "new", instance: "demo", out, send: async () => "0x02" });
    expect(readFileSync(out, "utf8").split("\n")).toEqual([
      ORIGINS_HEADER,
      "1301,old,0x01,9,1,2,prev",
      "1301,new,0x02,10,1700000000000,1700000000000,demo",
      "",
    ]);
  });

  test("trigger throws on a reverted origin tx and writes no evidence row", async () => {
    const out = tmpOut();
    minedAfter(10, 55n, "reverted");
    await expect(trigger({ chainId: 84532, kind: "deposit", instance: "demo", out, send: async () => "0xdead" }))
      .rejects.toThrow("deposit: origin tx reverted 0xdead");
    expect(existsSync(out)).toBe(false);
  });

  test("trigger propagates a failed send and never waits for a receipt or writes a row", async () => {
    const out = tmpOut();
    await expect(trigger({ chainId: 84532, kind: "k", instance: "i", out, send: async () => { throw new Error("insufficient funds"); } }))
      .rejects.toThrow("insufficient funds");
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
  });

  test("trigger writes to evidence/origins.csv under the working directory when no out path is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-trigger-cwd-"));
    mkdirSync(join(dir, "evidence"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      minedAfter(5, 77n);
      await trigger({ chainId: 84532, kind: "deposit", instance: "demo", send: async () => "0xdef" });
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(dir, "evidence", "origins.csv"), "utf8")).toBe(
      `${ORIGINS_HEADER}\n84532,deposit,0xdef,77,1700000000000,1700000000005,demo\n`,
    );
  });
});
