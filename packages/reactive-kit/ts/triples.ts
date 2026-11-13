// Tx-triple logger: origin (or CRON) tx -> reactive tx -> callback tx, with on-chain timestamps.
// Joins by data the contracts emit themselves (the RC logs the origin tx hash + a seq; the destination logs the seq),
// so it needs nothing but eth_getLogs on each chain. Output: evidence/triples.csv (rows are never dropped; a re-join of
// the same react updates its row in place, so a corrected join lands instead of sitting beside the stale one).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AbiEvent, Log } from "viem";
import { chain, client } from "./chains.ts";

export const TRIPLE_COLUMNS = [
  "stage", "seq", "trigger_kind", "trigger_chain", "trigger_tx", "trigger_ts", "reactive_tx", "reactive_ts",
  "callback_chain", "callback_tx", "callback_ts", "last_activity_chain", "last_activity_tx", "instance", "note",
] as const;
export type TripleColumn = (typeof TRIPLE_COLUMNS)[number];
export type TripleRow = Record<TripleColumn, string>;

export type Hex = `0x${string}`;

const tsCache = new Map<string, number>();

/** Unix seconds of a block (cached). */
export async function blockTs(chainId: number, blockNumber: bigint): Promise<number> {
  const k = `${chainId}:${blockNumber}`;
  const hit = tsCache.get(k);
  if (hit !== undefined) return hit;
  const b = await client(chainId).getBlock({ blockNumber });
  const ts = Number(b.timestamp);
  tsCache.set(k, ts);
  return ts;
}

/** Block number + timestamp of a mined tx. */
export async function txInfo(chainId: number, hash: Hex): Promise<{ block: bigint; ts: number; status: string }> {
  const r = await client(chainId).getTransactionReceipt({ hash });
  return { block: r.blockNumber, ts: await blockTs(chainId, r.blockNumber), status: r.status };
}

/** eth_getLogs split into the chain's accepted block span. */
export async function getLogsChunked(
  chainId: number,
  q: { address: Hex; event: AbiEvent; fromBlock: bigint; toBlock?: bigint; args?: Record<string, unknown> },
): Promise<Log[]> {
  const c = client(chainId);
  const to = q.toBlock ?? (await c.getBlockNumber());
  const span = chain(chainId).logSpan;
  const out: Log[] = [];
  for (let from = q.fromBlock; from <= to; from += span + 1n) {
    const end = from + span > to ? to : from + span;
    const logs = await c.getLogs({ address: q.address, event: q.event, args: q.args as never, fromBlock: from, toBlock: end });
    out.push(...(logs as Log[]));
  }
  return out;
}

/** Build one row from known tx hashes (timestamps fetched from chain). */
export async function buildTriple(p: {
  stage: string;
  seq: string | number | bigint;
  triggerKind: "origin_log" | "cron";
  triggerChain: number;
  triggerTx: Hex;
  reactiveChain: number;
  reactiveTx: Hex;
  callback?: { chainId: number; tx: Hex };
  lastActivity?: { chainId: number; tx: Hex };
  instance: string;
  note?: string;
}): Promise<TripleRow> {
  const trig = await txInfo(p.triggerChain, p.triggerTx);
  const rx = await txInfo(p.reactiveChain, p.reactiveTx);
  const cb = p.callback ? await txInfo(p.callback.chainId, p.callback.tx) : undefined;
  return {
    stage: p.stage,
    seq: String(p.seq),
    trigger_kind: p.triggerKind,
    trigger_chain: String(p.triggerChain),
    trigger_tx: p.triggerTx,
    trigger_ts: String(trig.ts),
    reactive_tx: p.reactiveTx,
    reactive_ts: String(rx.ts),
    callback_chain: p.callback ? String(p.callback.chainId) : "",
    callback_tx: p.callback?.tx ?? "",
    callback_ts: cb ? String(cb.ts) : "",
    last_activity_chain: p.lastActivity ? String(p.lastActivity.chainId) : "",
    last_activity_tx: p.lastActivity?.tx ?? "",
    instance: p.instance,
    note: p.note ?? "",
  };
}

// ---- CSV (no quoting needed except notes; notes are quoted when they contain commas) ----

function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsvLine(row: TripleRow): string {
  return TRIPLE_COLUMNS.map((c) => cell(row[c] ?? "")).join(",");
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function readTriples(path: string): TripleRow[] {
  if (!existsSync(path)) return [];
  const [header, ...lines] = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const cols = parseCsvLine(header);
  return lines.map((l) => {
    const v = parseCsvLine(l);
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""])) as TripleRow;
  });
}

/** Identity of a row: one react (reactive tx) for one (instance, stage, seq). The trigger is derived, so it is not
 *  part of the key: a re-join that finds a better trigger replaces the old one instead of adding a twin row. */
export function rowKey(r: TripleRow): string {
  return `${r.instance}|${r.stage}|${r.seq}|${r.reactive_tx.toLowerCase()}`;
}

const CALLBACK_LEG = new Set<TripleColumn>(["callback_chain", "callback_tx", "callback_ts"]);

/** True when `next` carries a callback leg that should replace `stored`'s: stored has none, or next's is earlier. */
function earlierCallback(next: TripleRow, stored: TripleRow): boolean {
  if (!next.callback_tx) return false;
  if (!stored.callback_tx) return true;
  const a = Number(next.callback_ts), b = Number(stored.callback_ts);
  return Number.isFinite(a) && Number.isFinite(b) && next.callback_ts !== "" && stored.callback_ts !== "" && a < b;
}

/** Upsert rows by `rowKey`: new rows are appended; a re-joined row updates its existing row in place, field by field,
 *  where the new value is non-empty (a later join that misses a leg never blanks one an earlier join found). The
 *  callback leg (chain, tx, ts) is the exception: it is replaced only by an earlier callback, never a later one.
 *  Rows that are not re-joined are kept (history survives RPC log pruning). Returns the number of rows added. */
export function appendTriples(path: string, rows: TripleRow[]): number {
  const all = readTriples(path);
  const at = new Map(all.map((r, i) => [rowKey(r), i] as const));
  let added = 0;
  for (const r of rows) {
    const k = rowKey(r);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, all.length);
      all.push(r);
      added++;
    } else {
      const merged = { ...all[i] };
      // The callback leg moves only to an EARLIER callback: a replayed sync re-emits a non-terminal Ack for the same
      // seq after the applying one, so a later join that missed the applying Ack must not replace the cited hash.
      const keepCallback = !earlierCallback(r, merged);
      for (const c of TRIPLE_COLUMNS) {
        if (r[c] === "" || r[c] === undefined) continue;
        if (keepCallback && CALLBACK_LEG.has(c)) continue;
        merged[c] = r[c];
      }
      all[i] = merged;
    }
  }
  writeFileSync(path, [TRIPLE_COLUMNS.join(","), ...all.map(toCsvLine)].join("\n") + "\n");
  return added;
}

/** Seconds between hops of a row (NaN when a leg is missing). */
export function hopSeconds(r: TripleRow): { triggerToReactive: number; reactiveToCallback: number; total: number } {
  const t = Number(r.trigger_ts), x = Number(r.reactive_ts), c = r.callback_ts ? Number(r.callback_ts) : NaN;
  return { triggerToReactive: x - t, reactiveToCallback: c - x, total: c - t };
}
