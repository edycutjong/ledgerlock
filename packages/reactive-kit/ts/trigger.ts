// trigger() convention: every script that fires an origin tx goes through `trigger()`, which
//  1. refuses to run without the key in the environment (keys live in ~/.config/<tool>/, never in the repo),
//  2. records wall-clock send/mined times and appends one row to evidence/origins.csv,
//  3. returns the tx hash so the caller can hand it to the triple logger.
// Row: chain_id,kind,origin_tx,block,sent_at_ms,mined_at_ms,instance
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { client } from "./chains.ts";
import type { Hex } from "./triples.ts";

export const ORIGINS_HEADER = "chain_id,kind,origin_tx,block,sent_at_ms,mined_at_ms,instance";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (source it from ~/.config/…; never commit it)`);
  return v;
}

export async function trigger(p: {
  chainId: number;
  kind: string;
  instance: string;
  send: () => Promise<Hex>;
  out?: string;
}): Promise<{ tx: Hex; block: bigint; sentAtMs: number; minedAtMs: number }> {
  const out = p.out ?? "evidence/origins.csv";
  const sentAtMs = Date.now();
  const tx = await p.send();
  const r = await client(p.chainId).waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
  const minedAtMs = Date.now();
  if (r.status !== "success") throw new Error(`${p.kind}: origin tx reverted ${tx}`);
  if (!existsSync(out)) writeFileSync(out, ORIGINS_HEADER + "\n");
  appendFileSync(out, [p.chainId, p.kind, tx, r.blockNumber, sentAtMs, minedAtMs, p.instance].join(",") + "\n");
  return { tx, block: r.blockNumber, sentAtMs, minedAtMs };
}
