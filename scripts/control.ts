// Paired outcome control, arm A0 (unguarded fixture). Same attack as bench.ts `burst`: one forged mint, then copycats (fixed
// 6, the same cap-style loop but nothing ever reverts), then a forged release of the same size on Base. Rows land in
// evidence/a0-control-runs.csv; the guarded arm A is bench.ts `burst` runs bu-021..bu-025 on the frozen deployment.
// Usage: source the deployer env; tsx scripts/control.ts <count>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, defineChain, http, keccak256, parseAbi, toHex, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAINS, client } from "../packages/reactive-kit/ts/chains.ts";

const A = Object.fromEntries(readFileSync("evidence/a0-addresses.txt", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string])) as Record<string, Hex>;
const OUT = "evidence/a0-control-runs.csv";
const COLS = ["run_id", "arm", "key", "attacker", "mint_tx", "copycats_fired", "copycats_landed", "unauthorized_issuance_tusd", "release_tx", "release_status", "collateral_released_tusd", "collateral_before_tusd", "collateral_after_tusd"];
if (!existsSync(OUT)) writeFileSync(OUT, COLS.join(",") + "\n");
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex, { nonceManager });
const wc = (id: number) => createWalletClient({ account, chain: defineChain({ id, name: CHAINS[id].name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc] } } }), transport: http(process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc) });
const W = { 84532: wc(84532), 1301: wc(1301) } as Record<number, ReturnType<typeof wc>>;
const lock = parseAbi(["function releaseByRelayer(uint64,address,uint256)", "function collateral() view returns (uint256)"]);
const mnt = parseAbi(["function mint(uint64,address,uint256)", "function totalSupply() view returns (uint256)"]);
const send = async (chain: number, to: Hex, abi: unknown, fn: string, args: unknown[]) => {
  const tx = await W[chain].writeContract({ address: to, abi: abi as never, functionName: fn as never, args: args as never, gas: 300_000n } as never);
  const r = await client(chain).waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
  return { tx, status: r.status };
};
const n = Number(process.argv[2] ?? 5), E18 = 10n ** 18n, amt = 500n * E18;
for (let i = 1; i <= n; i++) {
  const id = `a0-${String(i).padStart(3, "0")}`;
  if (readFileSync(OUT, "utf8").includes(id + ",")) continue;
  const key = 2_000_000n + BigInt(i) * 1000n, att = `0x${keccak256(toHex(`ledgerlock-attacker-${id}`)).slice(26)}` as Hex;
  const col0 = (await client(84532).readContract({ address: A.LOCKBOX, abi: lock, functionName: "collateral" })) as bigint;
  const m = await send(1301, A.MINTER, mnt, "mint", [key, att, amt]);
  let landed = m.status === "success" ? 1 : 0, fired = 0;
  for (let c = 1; c <= 6; c++) { fired = c; const cp = await send(1301, A.MINTER, mnt, "mint", [key + BigInt(c), att, amt]); if (cp.status === "success") landed++; }
  const rel = await send(84532, A.LOCKBOX, lock, "releaseByRelayer", [key + 1000n, att, amt]);
  const col1 = (await client(84532).readContract({ address: A.LOCKBOX, abi: lock, functionName: "collateral" })) as bigint;
  appendFileSync(OUT, [id, "A0_unguarded", key, att, m.tx, fired, landed - 1, landed * 500, rel.tx, rel.status, (col0 - col1) / E18, col0 / E18, col1 / E18].join(",") + "\n");
  console.log(id, "landed", landed, "release", rel.status);
}
