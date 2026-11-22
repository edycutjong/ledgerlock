// Route B runs: a Hyperlane warp route (Base native -> Unichain synthetic) guarded by the `frozen` LedgerlockReactive (route 2, SUPPLY mode), not the route A instance.
// legit  : transferRemote on Base, then OUR Mailbox.process on Unichain right after the dispatch mined (the public relayer did not
//          deliver, evidence/g2-hyperlane.csv); records dispatch->delivery delay and the order Lasna booked the two events.
// drill  : DrillBeacon.fire(2) -> Lasna react -> both PausableIsms paused through the real callbacks; a transfer sent during the
//          pause is held (our process() reverts), then owner resolve() reopens, then the held message delivers.
// Usage: source the deployer env; tsx scripts/routeb.ts legit <n> | drill <n>     Rows: evidence/frozen-routeb-runs.csv
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, decodeAbiParameters, defineChain, http, parseAbi, type Hex, type Log } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAINS, client } from "../packages/reactive-kit/ts/chains.ts";
import { getLogsChunked } from "../packages/reactive-kit/ts/triples.ts";

const [mode, countArg] = process.argv.slice(2);
const N = Number(countArg ?? 1), LASNA = 5318007, BASE = 84532, UNI = 1301;
const kv = (p: string) => Object.fromEntries(readFileSync(p, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => l.replace(/\s+#.*$/, "").split("=") as [string, string])) as Record<string, Hex>;
const F = kv("evidence/frozen-addresses.txt"), B = kv("evidence/route-b-addresses.txt"), G = kv("evidence/route-b-guard.txt");
const ROUTE = BigInt(G.ROUTE_ID_B ?? "2"); // written by script/routeb-deploy.sh from routeCount()
const OUT = "evidence/frozen-routeb-runs.csv";
const COLS = ["run_id", "kind", "send_tx", "dispatch_mined_ms", "process_tx", "process_mined_ms", "delay_s", "lasna_sent_seen_ms", "lasna_recv_seen_ms", "lasna_order", "false_latch", "pause_lasna_tx", "pause_u_tx", "pause_b_tx", "pause_u_s", "pause_b_s", "held_process_tx", "held_process_status", "resume_u_s", "outcome", "note"];
if (!existsSync(OUT)) writeFileSync(OUT, COLS.join(",") + "\n");
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex, { nonceManager });
const wc = (id: number) => createWalletClient({ account, chain: defineChain({ id, name: CHAINS[id].name, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc] } } }), transport: http(process.env[CHAINS[id].rpcEnv] || CHAINS[id].defaultRpc, { retryCount: 3 }) });
const W = { [LASNA]: wc(LASNA), [BASE]: wc(BASE), [UNI]: wc(UNI) } as Record<number, ReturnType<typeof wc>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const router = parseAbi(["function transferRemote(uint32,bytes32,uint256) payable returns (bytes32)"]);
const mailbox = parseAbi(["function process(bytes,bytes)", "event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)"]);
const beacon = parseAbi(["function fire(uint256)"]);
const rc = parseAbi(["function resolve(uint256,uint8,bool)", "event Observed(uint256 indexed routeId, uint8 side, uint256 key, bytes32 indexed originTx)",
  "event PauseRequested(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)", "event IncidentLatched(uint256 indexed routeId, uint8 cause, uint64 epoch)"]);
const rcState = parseAbi(["function routeState(uint256) view returns (bool,bool,bool,uint64,uint32,uint256,uint256)"]);
const gate = parseAbi(["event Paused(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)", "event Resumed(uint256 indexed routeId, uint64 epoch, bytes32 indexed originTx, uint256 key)"]);
const ev = (abi: ReturnType<typeof parseAbi>, n: string) => abi.find((x) => x.type === "event" && x.name === n) as never;
const META: Hex = "0x00000010000000100000001000000010"; // aggregation metadata: four empty module ranges (TrustedRelayerIsm + PausableIsm need none)
const MB_BASE: Hex = B.MAILBOX_BASE, MB_UNI: Hex = B.MAILBOX_UNI;
const REC = `0x${account.address.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

async function watch(chain: number, address: Hex, event: unknown, from: bigint, match: (l: Log & { args?: Record<string, unknown> }) => boolean, timeoutMs: number) {
  const c = client(chain), span = CHAINS[chain].logSpan, end = Date.now() + timeoutMs; let f = from, errs = 0;
  while (Date.now() < end) {
    try {
      const head = await c.getBlockNumber();
      while (f <= head && Date.now() < end) {
        const to = head < f + span - 1n ? head : f + span - 1n;
        const ls = (await c.getLogs({ address, event: event as never, fromBlock: f, toBlock: to })) as (Log & { args?: Record<string, unknown> })[];
        const hit = ls.find(match);
        if (hit) return { at: Date.now(), tx: hit.transactionHash as Hex, block: hit.blockNumber as bigint, logIndex: hit.logIndex as number };
        f = to + 1n;
      }
      errs = 0;
    } catch (e) { if (++errs === 5) console.error(`watch ${CHAINS[chain].name} ${address}: 5 errors in a row, still trying: ${String(e).slice(0, 160)}`); }
    await sleep(400);
  }
  return null;
}
async function send(chain: number, to: Hex, abi: unknown, fn: string, args: unknown[], value = 0n, gas = 600_000n) {
  const extra = chain === LASNA ? { type: "legacy" as const, gasPrice: 100_000_000_000n } : {};
  const tx = await W[chain].writeContract({ address: to, abi: abi as never, functionName: fn as never, args: args as never, value, gas, ...extra } as never);
  const r = await client(chain).waitForTransactionReceipt({ hash: tx, pollingInterval: 250 });
  return { tx, status: r.status, at: Date.now(), block: r.blockNumber, logs: r.logs };
}
async function transfer(amount: bigint) {
  const t = await send(BASE, B.ROUTE_B_COLLATERAL_BASE, router, "transferRemote", [1301, REC, amount], amount, 500_000n);
  const d = t.logs.find((l) => l.address.toLowerCase() === MB_BASE.toLowerCase() && l.topics[0] === "0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814")!;
  const [message] = decodeAbiParameters([{ type: "bytes" }], d.data);
  return { ...t, message: message as Hex };
}
const deliver = (message: Hex, gas = 600_000n) => send(UNI, MB_UNI, mailbox, "process", [META, message], 0n, gas);
const done = readFileSync(OUT, "utf8");

for (let i = 1; i <= N; i++) {
  const id = `${mode === "legit" ? "bl" : "bd"}-${String(i).padStart(2, "0")}`;
  if (done.includes(id + ",")) continue;
  const row: Record<string, unknown> = { run_id: id, kind: mode, outcome: "ok" };
  const h0 = { l: await client(LASNA).getBlockNumber(), b: await client(BASE).getBlockNumber(), u: await client(UNI).getBlockNumber() };
  try {
    if (mode === "legit") {
      const t = await transfer(1_000_000_000n + BigInt(i));
      const p = await deliver(t.message);
      const [s, r] = await Promise.all([
        watch(LASNA, F.RC, ev(rc, "Observed"), h0.l, (l) => l.args?.originTx === t.tx && l.args?.routeId === ROUTE, 90_000),
        watch(LASNA, F.RC, ev(rc, "Observed"), h0.l, (l) => l.args?.originTx === p.tx && l.args?.routeId === ROUTE, 90_000)]);
      const latched = (await getLogsChunked(LASNA, { address: F.RC, event: ev(rc, "IncidentLatched"), fromBlock: h0.l, args: { routeId: ROUTE } })).length > 0;
      // lasna_order = on-chain order of the two Lasna Observed logs (block, then logIndex), not which poll returned first
      Object.assign(row, { send_tx: t.tx, dispatch_mined_ms: t.at, process_tx: p.tx, process_mined_ms: p.at, delay_s: ((p.at - t.at) / 1000).toFixed(1), lasna_sent_seen_ms: s?.at, lasna_recv_seen_ms: r?.at,
        lasna_order: s && r ? ((s.block !== r.block ? s.block < r.block : s.logIndex < r.logIndex) ? "sent_first" : "received_first") : "", false_latch: latched ? 1 : 0, note: "delivery by our own Mailbox.process right after the dispatch mined (public relayer did not deliver)", outcome: p.status === "success" && s && r ? "ok" : "check" });
      if (latched) {
        // never acceptDeficit from here: accepting while the source event is still in flight double-counts it into the baseline.
        // Wait for the guard's deficit to return to 0, then a plain resolve; otherwise leave the route latched.
        let clear = false;
        for (let k = 0; k < 40 && !clear; k++) {
          const st = await client(LASNA).readContract({ address: F.RC, abi: rcState, functionName: "routeState", args: [ROUTE] }) as readonly [boolean, boolean, boolean, bigint, number, bigint, bigint];
          clear = st[5] === 0n && st[6] === 0n;
          if (!clear) await sleep(3000);
        }
        if (clear) {
          const rs = await send(LASNA, F.RC, rc, "resolve", [ROUTE, 1, false], 0n, 3_000_000n);
          row.note += rs.status === "success" ? "; FALSE LATCH resolved (deficit returned to 0)" : `; resolve receipt ${rs.status}: FALSE LATCH NOT resolved`;
        }
        else row.note += "; deficit persisted: not a reorder; route left latched";
      }
    } else {
      const wl = watch(LASNA, F.RC, ev(rc, "PauseRequested"), h0.l, (l) => l.args?.routeId === ROUTE, 120_000);
      const wu = watch(UNI, G.GATE_U2, ev(gate, "Paused"), h0.u, () => true, 120_000);
      const wb = watch(BASE, G.GATE_B2, ev(gate, "Paused"), h0.b, () => true, 120_000);
      const f = await send(BASE, G.DRILL_BEACON, beacon, "fire", [ROUTE], 0n, 100_000n);
      const [pl, pu, pb] = await Promise.all([wl, wu, wb]);
      Object.assign(row, { send_tx: f.tx, dispatch_mined_ms: f.at, pause_lasna_tx: pl?.tx, pause_u_tx: pu?.tx, pause_b_tx: pb?.tx, pause_u_s: pu ? ((pu.at - f.at) / 1000).toFixed(1) : "", pause_b_s: pb ? ((pb.at - f.at) / 1000).toFixed(1) : "" });
      const t = await transfer(2_000_000_000n + BigInt(i));           // sent during the pause
      await sleep(8000);
      let heldErr = "";
      const held = await deliver(t.message, 600_000n).catch((e) => { heldErr = String(e).slice(0, 80); return null; }); // reverts (mined) while the ISM is paused
      // only a mined reverted process() counts as held; a thrown send is "error", not "held"
      Object.assign(row, { held_process_tx: held?.tx, held_process_status: held ? held.status : "error" });
      const hu = Date.now();
      const wr = watch(UNI, G.GATE_U2, ev(gate, "Resumed"), await client(UNI).getBlockNumber(), () => true, 120_000);
      await send(LASNA, F.RC, rc, "resolve", [ROUTE, 1, false], 0n, 3_000_000n);
      const ru = await wr;
      Object.assign(row, { resume_u_s: ru ? ((ru.at - hu) / 1000).toFixed(1) : "" });
      const late = await deliver(t.message);
      Object.assign(row, { process_tx: late.tx, process_mined_ms: late.at, note: `held message delivered after resolve: ${late.status}`, outcome: pl && pu && pb && held?.status === "reverted" && late.status === "success" ? "ok" : "check" });
      if (!held) row.note += `; held-process send failed, not a mined revert: ${heldErr}`;
    }
  } catch (e) { row.outcome = "error"; row.note = String(e).slice(0, 140); }
  appendFileSync(OUT, COLS.map((c) => String(row[c] ?? "").replaceAll(",", ";").replaceAll('"', "'").replaceAll("\n", " ")).join(",") + "\n");
  console.log(id, row.outcome, row.note ?? "");
}
