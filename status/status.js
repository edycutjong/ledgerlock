// Ledgerlock status page: read-only. Renders data/status.json (built from evidence/) and reads live gate state straight from
// public testnet RPCs. Nothing here sends a transaction or holds a key.
"use strict";
const $ = (id) => document.getElementById(id);
const RPC = { 5318007: "https://lasna-rpc.rnk.dev/", 84532: "https://sepolia.base.org", 1301: "https://sepolia.unichain.org" };
const EXPLORER = { 5318007: "https://lasna.reactscan.net/tx/", 84532: "https://sepolia.basescan.org/tx/", 1301: "https://sepolia.uniscan.xyz/tx/" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (h) => (h && h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h || "");
const link = (chain, h) => (h ? `<a class="hash" href="${EXPLORER[chain]}${esc(h)}" rel="noopener" title="${esc(h)}">${esc(short(h))}</a>` : '<span class="muted">—</span>');
const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : Number(x).toFixed(d));
const pct = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.max(1, Math.ceil((p / 100) * v.length)) - 1] : NaN; };

async function rpc(chain, method, params) {
  const r = await fetch(RPC[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (chain, to, data) => rpc(chain, "eth_call", [{ to, data }, "latest"]);

function stateWord(open, requested) {
  if (open === null) return { cls: "unk", word: "live read failed" };
  if (open && requested) return { cls: "warn", word: "pause not confirmed" };
  return open ? { cls: "clear", word: "line clear" } : { cls: "blocked", word: "line blocked" };
}

async function live(d) {
  const a = d.addresses;
  const out = { gateB: null, gateU: null, gateB2: null, gateU2: null, rs: null, balRc: null, balB: null, balU: null };
  try { out.gateB = BigInt(await call(84532, a.GATE_B, "0x47535d7b")) === 1n; } catch { /* leave null */ }
  try { out.gateU = BigInt(await call(1301, a.GATE_U, "0x47535d7b")) === 1n; } catch { /* leave null */ }
  try {
    const w = (await call(5318007, a.RC, "0xc077dd00" + "0".repeat(63) + "1")).slice(2).match(/.{64}/g);
    out.rs = { paused: BigInt("0x" + w[0]) === 1n, incident: BigInt("0x" + w[1]) === 1n, epoch: Number(BigInt("0x" + w[3])), pending: Number(BigInt("0x" + w[4])), unbacked: BigInt("0x" + w[5]) };
  } catch { /* leave null */ }
  if (d.routeB && d.routeB.GATE_B2) {
    try { out.gateB2 = BigInt(await call(84532, d.routeB.GATE_B2, "0x47535d7b")) === 1n; } catch { /* null */ }
    try { out.gateU2 = BigInt(await call(1301, d.routeB.GATE_U2, "0x47535d7b")) === 1n; } catch { /* null */ }
  }
  try { out.balRc = Number(BigInt(await rpc(5318007, "eth_getBalance", [a.RC, "latest"])) / 10n ** 14n) / 1e4; } catch { /* */ }
  try { out.balB = Number(BigInt(await rpc(84532, "eth_getBalance", [a.GATE_B, "latest"])) / 10n ** 12n) / 1e6; } catch { /* */ }
  try { out.balU = Number(BigInt(await rpc(1301, "eth_getBalance", [a.GATE_U, "latest"])) / 10n ** 12n) / 1e6; } catch { /* */ }
  return out;
}

function track(label, sub, gb, gu, req, boxes) {
  const s = gb === null && gu === null ? stateWord(null) : stateWord(gb === true && gu === true, req);
  const split = gb !== null && gu !== null && gb !== gu;
  const word = split ? { cls: "warn", word: "split: one gate shut" } : s;
  const lamp = (open) => (open === null ? "" : open ? "clear" : "blocked");
  const rail = (open) => (open === null ? "" : open ? "clear" : "blocked");
  const g = (n, open) => `<div class="needle"><span class="lamp ${lamp(open)}"></span><span>${n}: ${open === null ? "live read failed" : open ? "OPEN" : "SHUT"}</span></div>`;
  return `<div class="route"><div><div class="eyebrow">${esc(sub)}</div><h3 class="disp">${esc(label)}</h3></div>
  <div class="state ${word.cls}" aria-live="polite">${word.word}</div>
  <div class="track"><div class="box"><h4>Base Sepolia</h4>${g("gate B", gb)}<div class="muted" style="font-size:14px">${esc(boxes.base)}</div><div class="rail ${rail(gb)}"></div></div>
  <div class="box mid"><h4>Lasna</h4><div class="muted" style="font-size:14px">${esc(boxes.mid)}</div><div class="rail"></div></div>
  <div class="box"><h4>Unichain Sepolia</h4>${g("gate U", gu)}<div class="muted" style="font-size:14px">${esc(boxes.uni)}</div><div class="rail ${rail(gu)}"></div></div></div></div>`;
}

function strip(title, xs, unit, p50, p95) {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return `<div class="strip"><div class="lab"><span>${esc(title)}</span><span class="empty">not measured yet</span></div></div>`;
  const max = Math.max(...v) * 1.05 || 1;
  const W = 1000, x = (n) => 10 + (n / max) * (W - 20);
  const dots = v.map((n, i) => `<circle cx="${x(n).toFixed(1)}" cy="${20 + ((i * 7) % 5) * 5}" r="3.4" fill="#EAE3CC" opacity=".8"/>`).join("");
  const tick = (n, c, t) => `<line x1="${x(n)}" x2="${x(n)}" y1="4" y2="52" stroke="${c}" stroke-width="2"/><text x="${Math.min(x(n) + 4, W - 70)}" y="50" fill="${c}" font-size="13" font-family="Chivo Mono,monospace">${t}</text>`;
  return `<div class="strip"><div class="lab"><span>${esc(title)}</span><span>n=<b>${v.length}</b> · p50 <b>${fmt(p50)}</b> ${unit} · p95 <b>${fmt(p95)}</b> ${unit} · max <b>${fmt(Math.max(...v))}</b> ${unit}</span></div>
  <svg viewBox="0 0 ${W} 56" role="img" aria-label="${esc(title)}: ${v.length} runs, p50 ${fmt(p50)} s, p95 ${fmt(p95)} s"><line x1="10" x2="${W - 10}" y1="52" y2="52" stroke="#34402F"/>${dots}${tick(p50, "#B8914A", "p50")}${tick(p95, "#F1DE9C", "p95")}</svg></div>`;
}

function render(d, lv) {
  const a = d.addresses, rs = lv.rs;
  const reqB = !!(rs && (rs.paused || rs.incident));
  const rbr = d.routeBRuns;
  const routeBHtml = d.routeB && d.routeB.GATE_B2 ? track("Route B · Hyperlane warp route", "Hyperlane mailbox + PausableIsm code; we deployed the route and deliver with our own Mailbox.process (the public relayer did not deliver)" + (d.routeBGuardRC ? ` · guarded by its own Lasna contract ${short(d.routeBGuardRC)}` : ""), lv.gateB2, lv.gateU2, false,
      { base: `native router ${short(d.routeB.ROUTE_B_COLLATERAL_BASE)}`, mid: rbr ? `${rbr.legit} legit transfers (self-delivered) · ${rbr.legit_false_latch} false latches · ${rbr.drills.length} drills` : "SUPPLY mode", uni: `synthetic ${short(d.routeB.ROUTE_B_SYNTHETIC_UNI)}` }) : "";
  $("routes").innerHTML =
    track("Route A · fixture bridge", "labelled fixture · we deployed both ends", lv.gateB, lv.gateU, reqB,
      { base: `LockBox ${short(a.LOCKBOX)}`, mid: rs ? `epoch ${rs.epoch} · ${rs.pending} pending${rs.incident ? " · INCIDENT LATCHED" : ""}` : "guard state: live read failed", uni: `Minter ${short(a.MINTER)}` }) +
    routeBHtml;
  const lowGate = [lv.balB, lv.balU].some((x) => x !== null && x < 0.0003);
  const bad = (lv.balRc !== null && lv.balRc < 1) || lowGate;
  $("health").className = "health" + (bad ? " bad" : "");
  $("health").textContent = lv.balRc === null ? "health: live read failed (RPC unreachable); evidence below still renders" :
    `${bad ? "UNHEALTHY: low reserve or gate balance" : "HEALTHY"} · guard reserve ${fmt(lv.balRc, 2)} lREACT · gate U ${fmt(lv.balU, 4)} ETH · gate B ${fmt(lv.balB, 4)} ETH`;

  const inc = d.incident;
  $("incident").innerHTML = inc ? `<div class="cards">
    <div class="stat"><div class="k">t0 · attacking mint mined</div><div class="v">0.0 s</div>${link(1301, inc.mint_tx)}</div>
    <div class="stat"><div class="k">t1 · Lasna react seen</div><div class="v">+${fmt(inc.detection_s)} s</div>${link(5318007, inc.lasna_tx)}</div>
    <div class="stat"><div class="k">t2 · gate U Paused</div><div class="v">+${fmt(inc.pause_u_s)} s</div>${link(1301, inc.gate_u_tx)}</div>
    <div class="stat"><div class="k">t3 · gate B Paused</div><div class="v">+${fmt(inc.pause_b_s)} s</div>${link(84532, inc.gate_b_tx)}</div></div>
    <p class="muted">Run ${esc(inc.id)} (${esc(inc.kind)}). ±${d.summary ? d.summary.poll_ms : 400} ms poll. ${inc.fired !== null ? `Copycats fired ${inc.fired} · landed before the pause ${inc.landed} · reverted GatePaused ${inc.fired - inc.landed}. Exposure ${inc.exposure_tusd} tUSD.` : "Single attacking mint, no copycats."}</p>
    <p class="note"><b>ACTION</b> after a pause: rotate the relayer key, seize the unbacked mints listed by the guard's Mismatch events, then owner calls resolve().</p>` : '<p class="empty">not measured yet</p>';

  const ctrl = new Set(d.controlArmIds || []);
  const att = d.runs.filter((r) => r.outcome === "ok" && /^(attack|burst)/.test(r.kind) && !ctrl.has(r.id));
  const legit = d.runs.filter((r) => r.kind === "legit_strict");
  const forced = d.runs.filter((r) => r.kind === "legit_forced");
  if (d.runs.length) {
    const S = d.summary?.latency_from_mint_mined.all_attacks;
    const col = (k) => att.map((r) => r[k]);
    $("numbers").innerHTML =
      strip("Detection (mint → Lasna react seen)", col("detection_s"), "s", pct(col("detection_s"), 50), pct(col("detection_s"), 95)) +
      strip("Pause, Unichain gate (mint → gate U Paused)", col("pause_u_s"), "s", pct(col("pause_u_s"), 50), pct(col("pause_u_s"), 95)) +
      strip("Pause, Base gate (mint → gate B Paused)", col("pause_b_s"), "s", pct(col("pause_b_s"), 50), pct(col("pause_b_s"), 95)) +
      `<div class="cards"><div class="stat"><div class="k">attack runs measured (60 forged + 20 plausible + 20 burst)</div><div class="v">${att.length}</div><div class="k">${esc((d.summary?.excluded_rows || []).map((e) => e.run + " " + e.outcome).join(", ")) || "none excluded"}${(d.summary?.excluded_rows || []).length ? ": af-001 is a harness artifact (reused key, NonceUsed), replaced by af-061" : ""}</div></div>
      <div class="stat"><div class="k">false pauses on strict legit transfers</div><div class="v">${legit.filter((r) => r.false_pause).length} of ${legit.length}</div><div class="k">cross-checked: every PauseRequested the guard emitted joins to a run (<a href="https://github.com/edycutjong/ledgerlock/blob/main/evidence/${esc(d.instance)}-pause-audit.csv">pause-audit.csv</a>)</div></div>
      <div class="stat"><div class="k">forced out-of-order: seconds the Unichain gate stayed shut, p50 · max</div><div class="v">${fmt(pct(forced.map((r) => r.pause_seconds), 50))} · ${fmt(Math.max(...forced.map((r) => r.pause_seconds)))}</div><div class="k">n=${forced.length}, labelled "forced fill-before-deposit" (lock follows the mint by 2–20 s by design)</div></div></div>
      ${S ? "" : ""}`;
  }

  // Window control: the 20 forced out-of-order runs (lock follows the mint by a recorded 2-20 s). Recorded data only.
  const delays = (d.lockDelays || []).filter(Number.isFinite);
  const strictN = d.skew.length, strictFirst = d.skew.filter((x) => x.mint_seen_first).length;
  if (delays.length) {
    $("wctl").innerHTML = `<div class="ctl"><label for="w">W = <b class="mono" id="wv">60</b> s</label><input id="w" type="range" min="2" max="90" step="1" value="60" aria-describedby="wout"></div>
    <p id="wout" class="note"></p><p class="muted">Recorded data only. The ${delays.length} forced runs are the only recorded arrivals where a mint preceded its lock, and their delays were set by us (2–20 s). The ${strictN} strict skew pairs from the P1a probe (a dev deployment) had the lock seen first ${strictN - strictFirst} times, so none of them could ever latch. This control re-counts those recordings; it does not simulate new runs, and it says nothing about delays beyond 20 s. The deployed W is 60 s, chosen from this evidence before the bench and never retuned.</p>`;
    const upd = () => { const w = Number($("w").value); $("wv").textContent = w; const n = delays.filter((x) => x > w).length;
      $("wout").textContent = `At W = ${w} s, ${n} of the ${delays.length} recorded forced out-of-order runs (lock delay ${Math.min(...delays)}–${Math.max(...delays)} s) would have been overdue and latched an incident.`; };
    $("w").addEventListener("input", upd); upd();
  }

  const bu = d.runs.filter((r) => r.kind === "burst" && !ctrl.has(r.id) && r.landed !== null && r.pause_u_s !== null);
  if (bu.length) {
    const W = 1000, H = 220, mx = Math.max(...bu.map((r) => r.pause_u_s)) * 1.1 || 1, my = Math.max(...bu.map((r) => r.landed), 1) * 1.2;
    const pts = bu.map((r) => `<circle cx="${(60 + (r.pause_u_s / mx) * (W - 90)).toFixed(1)}" cy="${(H - 30 - (r.landed / my) * (H - 50) - ((Number(r.id.slice(3)) % 5) * 5)).toFixed(1)}" r="5" fill="#F1DE9C" opacity=".85"><title>${esc(r.id)}: ${fmt(r.pause_u_s)} s, ${r.landed} copycats landed</title></circle>`).join("");
    $("exposure").innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-height:260px" role="img" aria-label="Copycat mints that landed before the pause, against the mint-to-gate-U-pause latency, ${bu.length} burst runs"><line x1="60" x2="${W - 20}" y1="${H - 30}" y2="${H - 30}" stroke="#34402F"/><line x1="60" x2="60" y1="10" y2="${H - 30}" stroke="#34402F"/>${pts}
    <text x="60" y="${H - 8}" fill="#85907F" font-size="13" font-family="Chivo Mono,monospace">mint → gate U Paused, s (0 … ${fmt(mx)})</text><text x="68" y="22" fill="#85907F" font-size="13" font-family="Chivo Mono,monospace">copycats landed (0 … ${fmt(my, 0)})</text></svg>
    <p class="note">Loss ≤ mints inside the pause window. In the ${bu.length} measured bursts (a forged mint, then one copycat per confirmed receipt) at most <b class="mono">${Math.max(...bu.map((r) => r.landed))}</b> copycat mints landed before the first GatePaused revert (median ${fmt(pct(bu.map((r) => r.landed), 50), 0)}); each was 500 tUSD; the max is a bound for these runs only. Dots are jittered vertically; gate B shut earlier than gate U in these runs, and the cause is not established here. Measured pairs only, no fitted line.</p>`;
  }

  $("register").innerHTML = d.triples.length ? `<table><thead><tr><th>time (UTC)</th><th>origin</th><th>Lasna tx</th><th>callback</th><th>note</th></tr></thead><tbody>${d.triples.map((t) =>
    `<tr><td>${t.ts ? new Date(Number(t.ts) * 1000).toISOString().slice(11, 19) : ""}</td><td>${link(Number(t.trigger_chain), t.trigger_tx)}</td><td>${link(5318007, t.reactive_tx)}</td><td>${t.callback_tx ? link(Number(t.callback_chain), t.callback_tx) : '<span class="muted">none (no-op)</span>'}</td><td class="muted">${esc((t.note || "").slice(0, 90))}</td></tr>`).join("")}</tbody></table>
    <p><a href="https://github.com/edycutjong/ledgerlock/blob/main/evidence/${esc(d.instance)}-triples.csv">all rows (CSV)</a></p>` : '<p class="empty">not measured yet</p>';

  const c = d.control;
  if (c) {
    const sum = (x) => x.reduce((a, b) => a + b, 0);
    $("numbers").insertAdjacentHTML("afterbegin", `<h3 class="disp" style="font-size:30px;margin:10px 0">Paired control: with and without the guard</h3><div class="scroll"><table><thead><tr><th>arm</th><th>runs</th><th>unauthorized tUSD issued per run</th><th>collateral released to the attacker per run (tUSD)</th><th>carry-home release</th></tr></thead><tbody>
      <tr><td>A0 · CONTROL · UNGUARDED · FIXTURE</td><td>${c.a0.runs}</td><td>${sum(c.a0.issued_per_run) / c.a0.runs}</td><td>${sum(c.a0.released_per_run) / c.a0.runs}</td><td>${esc([...new Set(c.a0.carry_home)].join(", "))}</td></tr>
      <tr><td>A · guarded by Ledgerlock · FIXTURE</td><td>${c.a.runs}</td><td>${sum(c.a.issued_per_run) / c.a.runs}</td><td>${sum(c.a.released_per_run) / c.a.runs}</td><td>${esc([...new Set(c.a.carry_home)].join(", "))}</td></tr></tbody></table></div><p class="muted">Both arms: one forged 500 tUSD mint, then copycat mints, then a forged 500 tUSD release on Base. A0 sends a fixed 6 copycats (nothing ever reverts, so its issuance is set by that choice and is illustrative); on A the loop sends one copycat per confirmed receipt until the first GatePaused revert, so the guarded column is the measurement. Runs: bu-021..025 (A) and a0-001..005 (A0).</p>`);
  }
  if (d.routeBRuns && d.routeBRuns.drills.length) {
    const dr = d.routeBRuns.drills;
    $("numbers").insertAdjacentHTML("beforeend", `<h3 class="disp" style="font-size:30px;margin:18px 0 6px">Route B drills (labelled owner drills, no attack staged)</h3><div class="scroll"><table><thead><tr><th>drill</th><th>gate U paused</th><th>gate B paused</th><th>transfer sent during the pause</th><th>Lasna</th><th>delivered after resolve()</th></tr></thead><tbody>${dr.map((r) => `<tr><td>${esc(r.id)}</td><td>+${fmt(r.pause_u_s)} s ${link(1301, r.pause_u_tx)}</td><td>+${fmt(r.pause_b_s)} s ${link(84532, r.pause_b_tx)}</td><td>${esc(r.held)} ${link(1301, r.held_tx)}</td><td>${link(5318007, r.pause_lasna_tx)}</td><td>${link(1301, r.delivered_tx)}</td></tr>`).join("")}</tbody></table></div>`);
  }
  const last = d.incident;
  $("verify").innerHTML = (last ? `<p><b>Verify:</b> the latest pause loop's four hashes: mint ${link(1301, last.mint_tx)} → Lasna ${link(5318007, last.lasna_tx)} → gate U ${link(1301, last.gate_u_tx)} · gate B ${link(84532, last.gate_b_tx)}. No setup needed.</p>` : "") +
    `<p><b>Hands-on:</b> <span class="mono">scripts/bench.ts</span> and <span class="mono">script/core-trigger.sh</span>. Needs your own funded testnet keys; setup in DEMO.md.</p>`;
}

(async function main() {
  let d;
  try { d = await (await fetch("data/status.json", { cache: "no-store" })).json(); } catch { $("routes").innerHTML = '<p class="empty">data/status.json could not be loaded.</p>'; return; }
  const none = { gateB: null, gateU: null, rs: null, balRc: null, balB: null, balU: null };
  const lv = await Promise.race([live(d), new Promise((r) => setTimeout(() => r(none), 8000))]);
  render(d, lv);
})();
