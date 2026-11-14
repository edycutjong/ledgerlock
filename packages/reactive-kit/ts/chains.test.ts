import { beforeEach, describe, expect, test, vi } from "vitest";

// viem is mocked: building a client must never open a connection, and the tests read back exactly which RPC URL and
// transport options client() chose.
const viem = vi.hoisted(() => ({
  http: vi.fn((url: string, opts: object) => ({ kind: "http-transport", url, opts })),
  createPublicClient: vi.fn((cfg: { transport: unknown }) => ({ kind: "public-client", transport: cfg.transport })),
}));
vi.mock("viem", () => viem);

import { assertSameNetworkClass, chain, CHAINS, client } from "./chains.ts";

beforeEach(() => {
  viem.http.mockClear();
  viem.createPublicClient.mockClear();
});

describe("chain registry", () => {
  test("chain returns the registry entry for a known id", () => {
    expect(chain(1301)).toBe(CHAINS[1301]);
    expect(chain(1301).callbackProxy).toBe("0x775c9B990ADe401060B78D0e98684eEf8d2466C1");
  });

  test("chain throws on an id that is not in the registry", () => {
    expect(() => chain(1)).toThrow("unknown chain 1");
  });

  test("every registry entry is keyed by its own id", () => {
    for (const [key, info] of Object.entries(CHAINS)) expect(info.id).toBe(Number(key));
  });

  test("assertSameNetworkClass names every chain when it rejects a testnet/mainnet mix", () => {
    expect(() => assertSameNetworkClass([84532, 1597])).toThrow("mixed testnet and mainnet chains: 84532,1597");
  });

  test("assertSameNetworkClass accepts an all-mainnet set", () => {
    expect(() => assertSameNetworkClass([1597, 8453])).not.toThrow();
  });

  test("assertSameNetworkClass rejects an unknown chain instead of ignoring it", () => {
    expect(() => assertSameNetworkClass([84532, 999])).toThrow("unknown chain 999");
  });
});

describe("client", () => {
  test("client uses the chain's RPC env var when it is set, with 3 retries 500 ms apart", () => {
    vi.stubEnv("BASE_SEPOLIA_RPC", "http://127.0.0.1:1/env-rpc");
    const c = client(84532);
    expect(viem.http).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:1/env-rpc", { retryCount: 3, retryDelay: 500 });
    expect(viem.createPublicClient).toHaveBeenCalledExactlyOnceWith({ transport: viem.http.mock.results[0].value });
    expect(c).toBe(viem.createPublicClient.mock.results[0].value);
  });

  test("client falls back to the public default RPC when the env var is empty", () => {
    vi.stubEnv("LASNA_RPC", "");
    client(5318007);
    expect(viem.http).toHaveBeenCalledExactlyOnceWith("https://lasna-rpc.rnk.dev/", { retryCount: 3, retryDelay: 500 });
  });

  test("client caches one instance per chain id, so a later env change does not rebuild it", () => {
    vi.stubEnv("UNICHAIN_SEPOLIA_RPC", "http://127.0.0.1:1/first");
    const first = client(1301);
    vi.stubEnv("UNICHAIN_SEPOLIA_RPC", "http://127.0.0.1:1/second");
    expect(client(1301)).toBe(first);
    expect(viem.createPublicClient).toHaveBeenCalledTimes(1);
    expect(viem.http).toHaveBeenCalledWith("http://127.0.0.1:1/first", expect.anything());
  });

  test("client keeps separate instances for different chains", () => {
    vi.stubEnv("ETHEREUM_SEPOLIA_RPC", "");
    vi.stubEnv("BASE_RPC", "");
    const sepolia = client(11155111);
    const base = client(8453);
    expect(sepolia).not.toBe(base);
    expect(viem.http.mock.calls.map((c) => c[0])).toEqual([
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://base-rpc.publicnode.com",
    ]);
  });

  test("client throws on an unknown chain and caches nothing", () => {
    expect(() => client(42)).toThrow("unknown chain 42");
    expect(viem.createPublicClient).not.toHaveBeenCalled();
  });
});
