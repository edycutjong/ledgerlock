// Chain registry for Reactive Network projects. RPC URLs come from the environment (never hard-coded keys).
// Proxies and explorers: dev.reactive.network "Origins & Destinations".
import { createPublicClient, http, type PublicClient } from "viem";

export interface ChainInfo {
  id: number;
  name: string;
  rpcEnv: string;
  defaultRpc: string;
  explorerTx: string; // prefix; append the tx hash
  callbackProxy?: `0x${string}`;
  /** max block span a public RPC accepts for eth_getLogs (sepolia.base.org caps at 200) */
  logSpan: bigint;
  testnet: boolean;
}

export const CHAINS: Record<number, ChainInfo> = {
  5318007: {
    id: 5318007, name: "Reactive Lasna", rpcEnv: "LASNA_RPC", defaultRpc: "https://lasna-rpc.rnk.dev/",
    explorerTx: "https://lasna.reactscan.net/tx/", logSpan: 5000n, testnet: true,
  },
  1597: {
    id: 1597, name: "Reactive Mainnet", rpcEnv: "REACTIVE_RPC", defaultRpc: "https://mainnet-rpc.rnk.dev/",
    explorerTx: "https://reactscan.net/tx/", logSpan: 5000n, testnet: false,
  },
  84532: {
    id: 84532, name: "Base Sepolia", rpcEnv: "BASE_SEPOLIA_RPC", defaultRpc: "https://sepolia.base.org",
    explorerTx: "https://sepolia.basescan.org/tx/", callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    logSpan: 180n, testnet: true,
  },
  11155111: {
    id: 11155111, name: "Ethereum Sepolia", rpcEnv: "ETHEREUM_SEPOLIA_RPC",
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com", explorerTx: "https://sepolia.etherscan.io/tx/",
    callbackProxy: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4", logSpan: 2000n, testnet: true,
  },
  1301: {
    id: 1301, name: "Unichain Sepolia", rpcEnv: "UNICHAIN_SEPOLIA_RPC", defaultRpc: "https://sepolia.unichain.org",
    explorerTx: "https://sepolia.uniscan.xyz/tx/", callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    logSpan: 2000n, testnet: true,
  },
  8453: {
    id: 8453, name: "Base", rpcEnv: "BASE_RPC", defaultRpc: "https://base-rpc.publicnode.com",
    explorerTx: "https://basescan.org/tx/", callbackProxy: "0xCc780DdE33f56f55dE778D42c930959374a4a068",
    logSpan: 2000n, testnet: false,
  },
};

export function chain(id: number): ChainInfo {
  const c = CHAINS[id];
  if (!c) throw new Error(`unknown chain ${id}`);
  return c;
}

const clients = new Map<number, PublicClient>();

/** Public client for a chain, RPC from `process.env[rpcEnv]` or the public default. */
export function client(id: number): PublicClient {
  let c = clients.get(id);
  if (!c) {
    const info = chain(id);
    const url = process.env[info.rpcEnv] || info.defaultRpc;
    c = createPublicClient({ transport: http(url, { retryCount: 3, retryDelay: 500 }) }) as PublicClient;
    clients.set(id, c);
  }
  return c;
}

/** A chain must never be mixed across testnet/mainnet in one instance. */
export function assertSameNetworkClass(ids: number[]): void {
  const classes = new Set(ids.map((i) => chain(i).testnet));
  if (classes.size > 1) throw new Error(`mixed testnet and mainnet chains: ${ids.join(",")}`);
}
