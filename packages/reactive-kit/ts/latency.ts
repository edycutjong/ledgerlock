// Off-chain wall-clock latency observer. Block timestamps have 1 s resolution; this measures what a user waits:
// local clock at send -> origin mined -> reactive log first observed -> callback log first observed.
// The observer's own polling interval bounds its resolution (reported alongside every sample).
import type { AbiEvent, Log } from "viem";
import { client } from "./chains.ts";
import type { Hex } from "./triples.ts";

export interface LegWatch {
  chainId: number;
  address: Hex;
  event: AbiEvent;
  /** returns true for the log that completes this leg */
  match: (log: Log & { args?: Record<string, unknown> }) => boolean;
}

export interface LatencySample {
  sentAtMs: number;
  originMinedAtMs: number;
  reactiveSeenAtMs: number | null;
  callbackSeenAtMs: number | null;
  reactiveTx: Hex | null;
  callbackTx: Hex | null;
  pollMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(w: LegWatch, fromBlock: bigint, deadlineMs: number, pollMs: number): Promise<{ at: number; tx: Hex } | null> {
  const c = client(w.chainId);
  let from = fromBlock;
  while (Date.now() < deadlineMs) {
    const head = await c.getBlockNumber();
    if (head >= from) {
      const logs = (await c.getLogs({ address: w.address, event: w.event, fromBlock: from, toBlock: head })) as (Log & { args?: Record<string, unknown> })[];
      const hit = logs.find(w.match);
      if (hit) return { at: Date.now(), tx: hit.transactionHash as Hex };
      from = head + 1n;
    }
    await sleep(pollMs);
  }
  return null;
}

/**
 * Send an origin tx via `send()` (which must resolve once mined, returning the tx hash), then watch the reactive and
 * callback legs. Start blocks are captured BEFORE sending so a fast leg cannot be missed.
 */
export async function observe(p: {
  send: () => Promise<Hex>;
  reactive: LegWatch;
  callback?: LegWatch;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<LatencySample & { originTx: Hex }> {
  const pollMs = p.pollMs ?? 500;
  const deadline = Date.now() + (p.timeoutMs ?? 180_000);
  const rStart = await client(p.reactive.chainId).getBlockNumber();
  const cStart = p.callback ? await client(p.callback.chainId).getBlockNumber() : 0n;
  const sentAtMs = Date.now();
  const originTx = await p.send();
  const originMinedAtMs = Date.now();
  const r = await waitFor(p.reactive, rStart, deadline, pollMs);
  const c = p.callback && r ? await waitFor(p.callback, cStart, deadline, pollMs) : null;
  return {
    originTx, sentAtMs, originMinedAtMs,
    reactiveSeenAtMs: r?.at ?? null, callbackSeenAtMs: c?.at ?? null,
    reactiveTx: r?.tx ?? null, callbackTx: c?.tx ?? null, pollMs,
  };
}

/** Nearest-rank percentile over finite samples (no interpolation, so every reported value was actually observed). */
export function percentile(xs: number[], p: number): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[rank - 1];
}
