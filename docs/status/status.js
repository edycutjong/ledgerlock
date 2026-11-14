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
const ex = (x) => (Number.isFinite(x) ? String(+Number(x).toFixed(3)) : "n/a"); // 3.873, 5.92, 8.245: the bench-summary digits
const pct = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.max(1, Math.ceil((p / 100) * v.length)) - 1] : NaN; };

async function rpc(chain, method, params) {
  const r = await fetch(RPC[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (chain, to, data) => rpc(chain, "eth_call", [{ to, data }, "latest"]);

let PENDING = true; // first paint renders the committed evidence at once; the live gate reads fill in after (no layout shift)
function stateWord(open, requested) {
  if (open === null) return { cls: "unk", word: PENDING ? "reading gates" : "live read failed" };
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
  const tl = (open) => (open === null ? "" : open ? "c" : "r"); // the two track lamps beside the state word: gate B, gate U
  const g = (n, open) => `<div class="needle"><span class="lamp ${lamp(open)}"></span><span>${n}: ${open === null ? (PENDING ? "reading…" : "live read failed") : open ? "OPEN" : "SHUT"}</span></div>`;
  return `<div class="route"><div><div class="eyebrow">${esc(sub)}</div><h3 class="disp">${esc(label)}</h3></div>
  <div class="state ${word.cls}" aria-live="polite"><span class="tl" aria-hidden="true"><b class="${tl(gb)}"></b><b class="${tl(gu)}"></b></span>${word.word}</div>
  <div class="track"><div class="box"><h4>Base Sepolia</h4>${g("gate B", gb)}<div class="muted" style="font-size:14px">${esc(boxes.base)}</div><div class="rail ${rail(gb)}"></div></div>
  <div class="box mid"><h4>Lasna</h4><div class="muted" style="font-size:14px">${esc(boxes.mid)}</div><div class="rail"></div></div>
  <div class="box"><h4>Unichain Sepolia</h4>${g("gate U", gu)}<div class="muted" style="font-size:14px">${esc(boxes.uni)}</div><div class="rail ${rail(gu)}"></div></div></div></div>`;
}

// Dot strips, drawn at the container's own pixel width (viewBox width = clientWidth), so 1 SVG unit = 1 CSS px and no
// label ever scales below its set size: a phone gets the same 12-13 px text as a desktop. Redrawn on resize.
// One dot per run, stacked upward in time bins (the landing's bench plot, same marks); every strip shares one 0..DOMAIN s
// axis so detection and the two gates read against each other; the percentile labels sit in their own row above the
// tallest stack, so no label is ever drawn over a dot.
let DOMAIN = 12, RING = null; // RING = the last attack run's id, ringed in every strip (the cards above are that run)
const SPECS = new Map();
let specN = 0;
const slot = (spec) => { const id = `c${++specN}`; SPECS.set(id, spec); return `<div class="chart" data-chart="${id}"></div>`; };
const g1 = (n) => n.toFixed(1);
const textW = (t, fs) => t.length * fs * 0.6; // Chivo Mono advance is 0.6 em

function dotsSVG(spec, w) {
  const phone = w < 560, c = !!spec.compact;
  const r = c ? (phone ? 2.3 : 2.7) : phone ? 3.1 : 3.8, step = 2 * r + (c ? 1 : 1.4), fsP = phone ? 12 : 13;
  const x0 = 16, x1 = w - 20, sx = (t) => x0 + (Math.min(t, DOMAIN) / DOMAIN) * (x1 - x0);
  // bin every row first, so all rows of one chart share one vertical pitch (column heights compare across rows); a
  // column taller than maxH packs its dots closer instead of growing the chart
  const binned = spec.rows.map((row) => { const m = new Map();
    for (const it of row.items) { const k = Math.round((sx(it.v) - x0) / step); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m; });
  const tallAll = Math.max(1, ...binned.flatMap((m) => [...m.values()].map((v) => v.length)));
  const maxH = spec.maxH ? spec.maxH(phone) : Infinity;
  const rise = Math.min(2 * r + (c ? 0.8 : 1.2), tallAll > 1 ? (maxH - 2 * r) / (tallAll - 1) : Infinity);
  let y = 0;
  const under = [], out = [];
  spec.rows.forEach((row, ri) => {
    const bins = binned[ri], tall = Math.max(1, ...[...bins.values()].map((v) => v.length)), lines = [];
    if (row.head) { y += (ri ? 22 : 0) + 16; out.push(`<text class="rh" x="${x0}" y="${y}">${esc(row.head)}</text>`); y += 4; }
    if (row.p50 !== undefined) { // percentile label row: p50 to the left of its line, p95 to the right; a clash drops p50 one row
      y += fsP + 6; const labY = y;
      const a1x = sx(row.p50), b1x = sx(row.p95), t50 = `p50 ${ex(row.p50)} s`, t95 = `p95 ${ex(row.p95)} s`;
      let a1 = a1x - 6, anc50 = "end"; if (a1 - textW(t50, fsP) < 0) { a1 = a1x + 6; anc50 = "start"; }
      let b1 = b1x + 6, anc95 = "start"; if (b1 + textW(t95, fsP) > w) { b1 = b1x - 6; anc95 = "end"; }
      const span = (x, t, anc) => (anc === "end" ? [x - textW(t, fsP), x] : [x, x + textW(t, fsP)]);
      const s50 = span(a1, t50, anc50), s95 = span(b1, t95, anc95), clash = s50[1] + 8 > s95[0] && s95[1] + 8 > s50[0];
      const y50 = clash ? y + fsP + 4 : y; if (clash) y += fsP + 4;
      lines.push({ x: a1x, y: y50 + 5, cls: "p50" }, { x: b1x, y: labY + 5, cls: "p95" });
      out.push(`<text class="pl p50" x="${g1(a1)}" y="${y50}" text-anchor="${anc50}">${t50}</text><text class="pl p95" x="${g1(b1)}" y="${labY}" text-anchor="${anc95}">${t95}</text>`);
    }
    y += 10;
    const base = y + (tall - 1) * rise + r, axisY = base + r + 4;
    const pts = [];
    let ring = null;
    for (const [k, items] of [...bins.entries()].sort((p, q) => p[0] - q[0])) items.forEach((it, j) => {
      const cx = x0 + k * step, cy = base - j * rise, hit = it.id === RING;
      if (hit) ring = [cx, cy];
      pts.push(`<circle cx="${g1(cx)}" cy="${g1(cy)}" r="${r}" style="--i:${pts.length}"${hit ? ' class="ring-dot"' : ""}><title>${esc(it.id)} · ${it.v} s${it.tip ? " · " + esc(it.tip) : ""}</title></circle>`);
    });
    for (const l of lines) under.push(`<line class="pv ${l.cls}" x1="${g1(l.x)}" x2="${g1(l.x)}" y1="${l.y}" y2="${g1(axisY)}"/>`);
    out.push(`<line class="base" x1="${x0}" x2="${x1}" y1="${g1(axisY)}" y2="${g1(axisY)}"/><g class="${row.cls || "pts"}">${pts.join("")}</g>`);
    if (ring) out.push(`<circle class="ring" cx="${g1(ring[0])}" cy="${g1(ring[1])}" r="${r + 3.4}"/>`);
    y = axisY;
  });
  const every = (x1 - x0) / DOMAIN >= 46 ? 1 : 2;
  const ticks = [];
  for (let t = 0; t <= DOMAIN; t += every) ticks.push(`<line x1="${g1(sx(t))}" x2="${g1(sx(t))}" y1="${g1(y)}" y2="${g1(y + 5)}"/><text x="${g1(sx(t))}" y="${g1(y + 20)}">${t}${t === DOMAIN || t === 0 ? " s" : ""}</text>`);
  y += 24;
  if (spec.axis) { y += 16; ticks.push(`<text class="at" x="${x0}" y="${g1(y)}">${esc(spec.axis)}</text>`); }
  const H = Math.ceil(y + 6);
  return `<svg class="ds${phone ? " ph" : ""}${c ? " cp" : ""}" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${esc(spec.aria)}">${under.join("")}${out.join("")}<g class="axis">${ticks.join("")}</g></svg>`;
}

function drawCharts() {
  document.querySelectorAll("[data-chart]").forEach((el) => {
    const spec = SPECS.get(el.dataset.chart), w = Math.floor(el.clientWidth);
    if (!spec || !w || el.dataset.w === String(w)) return;
    el.dataset.w = String(w);
    el.innerHTML = dotsSVG(spec, w);
    // drawn in its final state; the drop-in plays once when the chart scrolls into view (screenshots and print see every dot)
    if (!el.dataset.seen) { el.dataset.seen = "1"; if (IO && !matchMedia("(prefers-reduced-motion: reduce)").matches) IO.observe(el); }
    RO.observe(el);
  });
}
const RO = "ResizeObserver" in window ? new ResizeObserver(() => requestAnimationFrame(drawCharts)) : { observe() {} };
const IO = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; IO.unobserve(e.target);
  const el = e.target; el.classList.add("armed"); void el.getBoundingClientRect(); el.classList.add("play"); setTimeout(() => el.classList.remove("armed", "play"), 2200); }), { threshold: 0.35 }) : null;

function strip(title, rows, unit, cls) {
  const v = rows.filter((r) => Number.isFinite(r.v));
  if (!v.length) return `<div class="strip"><div class="lab"><span>${esc(title)}</span><span class="empty">not measured yet</span></div></div>`;
  const xs = v.map((r) => r.v), p50 = pct(xs, 50), p95 = pct(xs, 95), mx = Math.max(...xs), ring = v.find((r) => r.id === RING);
  return `<div class="strip"><div class="lab"><span class="t">${esc(title)}</span><span class="nums">n=<b>${v.length}</b> · p50 <b>${ex(p50)}</b> ${unit} · p95 <b>${ex(p95)}</b> ${unit} · max <b>${ex(mx)}</b> ${unit}${ring ? ` · <span class="rk"><i aria-hidden="true"></i>${esc(RING)} <b>${ex(ring.v)}</b> ${unit}</span>` : ""}</span></div>
  ${slot({ rows: [{ items: v, p50, p95, cls: `pts ${cls}` }], maxH: (ph) => (ph ? 210 : 240), aria: `${title}: ${v.length} runs, p50 ${ex(p50)} s, p95 ${ex(p95)} s, max ${ex(mx)} s${ring ? `; ringed: ${RING}, the last attack run, ${ex(ring.v)} s` : ""}` })}</div>`;
}

function parts(rows) { // the three legs of the loop as small multiples: one chart, one axis, one shared column pitch
  const R = rows.map((r) => { const v = r.v.filter((x) => Number.isFinite(x.v)), xs = v.map((x) => x.v);
    return { head: r.h, items: v, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs), cls: `pts ${r.cls}` }; }).filter((r) => r.items.length);
  if (!R.length) return "";
  return `<div class="strip parts"><div class="lab"><span class="t">The loop, leg by leg</span><span class="nums">${R.map((r) => `${esc(r.head.split(" · ")[0])} max <b>${ex(r.max)}</b> s`).join(" · ")}</span></div>
  ${slot({ compact: true, rows: R, maxH: () => 58, aria: R.map((r) => `${r.head}: ${r.items.length} runs, p50 ${ex(r.p50)} s, p95 ${ex(r.p95)} s, max ${ex(r.max)} s`).join("; ") + (RING ? `; ringed: ${RING}, the last attack run` : "") })}</div>`;
}

function render(d, lv) {
  const a = d.addresses, rs = lv.rs;
  const reqB = !!(rs && (rs.paused || rs.incident));
  const rbr = d.routeBRuns;
  const routeBHtml = d.routeB && d.routeB.GATE_B2 ? track("Route B · Hyperlane warp route", "Hyperlane mailbox + PausableIsm code; we deployed the route and deliver with our own Mailbox.process (the public relayer did not deliver)" + (d.routeBGuardRC ? ` · guarded by its own Lasna contract ${short(d.routeBGuardRC)}` : ""), lv.gateB2, lv.gateU2, false,
      { base: `native router ${short(d.routeB.ROUTE_B_COLLATERAL_BASE)}`, mid: rbr ? `${rbr.legit} legit transfers (self-delivered) · ${rbr.legit_false_latch} false latches · ${rbr.drills.length} drills` : "SUPPLY mode", uni: `synthetic ${short(d.routeB.ROUTE_B_SYNTHETIC_UNI)}` }) : "";
  $("routes").innerHTML =
    track("Route A · fixture bridge", "labelled fixture · we deployed both ends", lv.gateB, lv.gateU, reqB,
      { base: `LockBox ${short(a.LOCKBOX)}`, mid: rs ? `epoch ${rs.epoch} · ${rs.pending} pending${rs.incident ? " · INCIDENT LATCHED" : ""}` : (PENDING ? "guard state: reading…" : "guard state: live read failed"), uni: `Minter ${short(a.MINTER)}` }) +
    routeBHtml;
  const lowGate = [lv.balB, lv.balU].some((x) => x !== null && x < 0.0003);
  const bad = (lv.balRc !== null && lv.balRc < 1) || lowGate;
  $("health").className = "health" + (bad ? " bad" : "");
  $("health").textContent = lv.balRc === null && PENDING ? "health: reading live RPCs…" : lv.balRc === null ? "health: live read failed (RPC unreachable); evidence below still renders" :
    `${bad ? "UNHEALTHY: low reserve or gate balance" : "HEALTHY"} · guard reserve ${fmt(lv.balRc, 2)} lREACT · gate U ${fmt(lv.balU, 4)} ETH · gate B ${fmt(lv.balB, 4)} ETH`;
}

// The committed evidence: rendered once (the live reads above never redraw it, so a chart never re-animates and the
// W slider keeps its value when the gate reads land).
function evidence(d) {
  const inc = d.incident;
  RING = inc ? inc.id : null;
  $("incident").innerHTML = inc ? `<div class="cards">
    <div class="stat"><div class="k">t0 · attacking mint mined</div><div class="v">0.000 s</div>${link(1301, inc.mint_tx)}</div>
    <div class="stat"><div class="k">t1 · Lasna react seen</div><div class="v">+${ex(inc.detection_s)} s</div>${link(5318007, inc.lasna_tx)}</div>
    ${[["gate U", inc.pause_u_s, 1301, inc.gate_u_tx], ["gate B", inc.pause_b_s, 84532, inc.gate_b_tx]]
      .sort((x, y) => x[1] - y[1]) // time order: whichever gate's chain included its callback first
      .map(([g, s, chain, tx], i) => `<div class="stat"><div class="k">t${i + 2} · ${g} Paused</div><div class="v">+${ex(s)} s</div>${link(chain, tx)}</div>`).join("")}</div>
    <p class="muted">Run ${esc(inc.id)} (${esc(inc.kind)}). ±${d.summary ? d.summary.poll_ms : 400} ms poll. ${inc.fired !== null ? `Copycats fired ${inc.fired} · landed before the pause ${inc.landed} · reverted GatePaused ${inc.fired - inc.landed}. Exposure ${inc.exposure_tusd} tUSD.` : "Single attacking mint, no copycats."}</p>
    <p class="note"><b>ACTION</b> after a pause: rotate the relayer key, seize the unbacked mints listed by the guard's Mismatch events, then owner calls resolve().</p>` : '<p class="empty">not measured yet</p>';

  const ctrl = new Set(d.controlArmIds || []);
  const att = d.runs.filter((r) => r.outcome === "ok" && /^(attack|burst)/.test(r.kind) && !ctrl.has(r.id));
  const legit = d.runs.filter((r) => r.kind === "legit_strict");
  const forced = d.runs.filter((r) => r.kind === "legit_forced");
  if (d.runs.length) {
    const both = (r) => (Number.isFinite(r.pause_u_s) && Number.isFinite(r.pause_b_s) ? Math.max(r.pause_u_s, r.pause_b_s) : NaN);
    const col = (f) => att.map((r) => ({ id: r.id, v: typeof f === "string" ? r[f] : f(r), tip: r.kind.replace("_", " ") }));
    const all = att.flatMap((r) => [r.detection_s, r.pause_u_s, r.pause_b_s]).filter(Number.isFinite);
    DOMAIN = Math.max(2, Math.ceil(Math.max(...all, ...d.runs.filter((r) => r.kind === "burst").map((r) => r.pause_u_s).filter(Number.isFinite)) / 2) * 2);
    $("numbers").innerHTML =
      `<div class="strips"><p class="eyebrow">${att.length} attack runs · seconds from the attacking mint · one dot per run · same axis on every strip</p>` +
      strip("Both gates shut · the later of gate B and gate U", col(both), "s", "both") +
      parts([["Detection · Lasna react seen", "detection_s", "det"], ["Gate B Paused · Base Sepolia", "pause_b_s", "gate"], ["Gate U Paused · Unichain Sepolia", "pause_u_s", "gate"]].map(([h, k, cls]) => ({ h, cls, v: col(k) }))) +
      `<p class="muted leg"><span class="rk"><i aria-hidden="true"></i>ringed</span>: ${esc(RING || "")}, the last attack run above, in every strip. Hover a dot for its run id. Nearest-rank percentiles, the same rows as <a href="https://github.com/edycutjong/ledgerlock/blob/main/evidence/${esc(d.instance)}-bench-summary.md">${esc(d.instance)}-bench-summary.md</a>.</p></div>` +
      `<div class="cards"><div class="stat"><div class="k">attack runs measured (60 forged + 20 plausible + 20 burst)</div><div class="v">${att.length}</div><div class="k">${esc((d.summary?.excluded_rows || []).map((e) => e.run + " " + e.outcome).join(", ")) || "none excluded"}${(d.summary?.excluded_rows || []).length ? ": af-001 is a harness artifact (reused key, NonceUsed), replaced by af-061" : ""}</div></div>
      <div class="stat"><div class="k">false pauses on strict legit transfers</div><div class="v">${legit.filter((r) => r.false_pause).length} of ${legit.length}</div><div class="k">cross-checked: every PauseRequested the guard emitted joins to a run (<a href="https://github.com/edycutjong/ledgerlock/blob/main/evidence/${esc(d.instance)}-pause-audit.csv">pause-audit.csv</a>)</div></div>
      <div class="stat"><div class="k">forced out-of-order: seconds the Unichain gate stayed shut, p50 · max</div><div class="v">${fmt(pct(forced.map((r) => r.pause_seconds), 50))} · ${fmt(Math.max(...forced.map((r) => r.pause_seconds)))}</div><div class="k">n=${forced.length}, labelled "forced fill-before-deposit" (lock follows the mint by 2–20 s by design)</div></div></div>
`;
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
    const L = [...new Set(bu.map((r) => r.landed))].sort((x, y) => x - y);
    $("exposure").innerHTML = slot({
      rows: L.map((n) => { const items = bu.filter((r) => r.landed === n).map((r) => ({ id: r.id, v: r.pause_u_s, tip: `${n} copycat${n === 1 ? "" : "s"} landed` }));
        return { head: `${n} copycat${n === 1 ? "" : "s"} landed · ${items.length} run${items.length === 1 ? "" : "s"}`, items, cls: n ? "pts lost" : "pts held" }; }),
      axis: "mint → gate U Paused, seconds",
      aria: `Copycat mints that landed before the pause, by mint-to-gate-U-pause latency, ${bu.length} burst runs: ` + L.map((n) => `${bu.filter((r) => r.landed === n).length} runs with ${n} landed`).join(", "),
    }) + `
    <p class="note">Loss ≤ mints inside the pause window. In the ${bu.length} measured bursts (a forged mint, then one copycat per confirmed receipt) at most <b class="mono">${Math.max(...bu.map((r) => r.landed))}</b> copycat mints landed before the first GatePaused revert (median ${fmt(pct(bu.map((r) => r.landed), 50), 0)}); each was 500 tUSD; the max is a bound for these runs only. One dot per burst run, stacked where runs share a time bin; gate B shut earlier than gate U in these runs, and the cause is not established here. Measured pairs only, no fitted line.</p>`;
  }

  $("register").innerHTML = d.triples.length ? `<table><thead><tr><th>time (UTC)</th><th>origin</th><th>Lasna tx</th><th>callback</th><th>note</th></tr></thead><tbody>${d.triples.map((t) =>
    `<tr><td>${t.ts ? new Date(Number(t.ts) * 1000).toISOString().slice(11, 19) : ""}</td><td>${link(Number(t.trigger_chain), t.trigger_tx)}</td><td>${link(5318007, t.reactive_tx)}</td><td>${t.callback_tx ? link(Number(t.callback_chain), t.callback_tx) : '<span class="muted">none (no-op)</span>'}</td><td class="muted">${esc((t.note || "").slice(0, 90))}</td></tr>`).join("")}</tbody></table>
    <p><a href="https://github.com/edycutjong/ledgerlock/blob/main/evidence/${esc(d.instance)}-triples.csv">all rows (CSV)</a></p>` : '<p class="empty">not measured yet</p>';

  const c = d.control;
  if (c) {
    const sum = (x) => x.reduce((a, b) => a + b, 0);
    $("numbers").insertAdjacentHTML("afterbegin", `<h3 class="disp" style="font-size:30px;margin:10px 0">Paired control: with and without the guard</h3><div class="scroll" tabindex="0" role="region" aria-label="Paired control table, scrollable"><table><thead><tr><th>arm</th><th>runs</th><th>unauthorized tUSD issued per run</th><th>collateral released to the attacker per run (tUSD)</th><th>carry-home release</th></tr></thead><tbody>
      <tr><td>A0 · CONTROL · UNGUARDED · FIXTURE</td><td>${c.a0.runs}</td><td>${sum(c.a0.issued_per_run) / c.a0.runs}</td><td>${sum(c.a0.released_per_run) / c.a0.runs}</td><td>${esc([...new Set(c.a0.carry_home)].join(", "))}</td></tr>
      <tr><td>A · guarded by Ledgerlock · FIXTURE</td><td>${c.a.runs}</td><td>${sum(c.a.issued_per_run) / c.a.runs}</td><td>${sum(c.a.released_per_run) / c.a.runs}</td><td>${esc([...new Set(c.a.carry_home)].join(", "))}</td></tr></tbody></table></div><p class="muted">Both arms: one forged 500 tUSD mint, then copycat mints, then a forged 500 tUSD release on Base. A0 sends a fixed 6 copycats (nothing ever reverts, so its issuance is set by that choice and is illustrative); on A the loop sends one copycat per confirmed receipt until the first GatePaused revert, so the guarded column is the measurement. Runs: bu-021..025 (A) and a0-001..005 (A0).</p>`);
  }
  if (d.routeBRuns && d.routeBRuns.drills.length) {
    const dr = d.routeBRuns.drills;
    $("numbers").insertAdjacentHTML("beforeend", `<h3 class="disp" style="font-size:30px;margin:18px 0 6px">Route B drills (labelled owner drills, no attack staged)</h3><div class="scroll" tabindex="0" role="region" aria-label="Route B drills table, scrollable"><table><thead><tr><th>drill</th><th>gate U paused</th><th>gate B paused</th><th>transfer sent during the pause</th><th>Lasna</th><th>delivered after resolve()</th></tr></thead><tbody>${dr.map((r) => `<tr><td>${esc(r.id)}</td><td>+${fmt(r.pause_u_s)} s ${link(1301, r.pause_u_tx)}</td><td>+${fmt(r.pause_b_s)} s ${link(84532, r.pause_b_tx)}</td><td>${esc(r.held)} ${link(1301, r.held_tx)}</td><td>${link(5318007, r.pause_lasna_tx)}</td><td>${link(1301, r.delivered_tx)}</td></tr>`).join("")}</tbody></table></div>`);
  }
  const last = d.incident;
  $("verify").innerHTML = (last ? `<p><b>Verify:</b> the latest pause loop's four hashes: mint ${link(1301, last.mint_tx)} → Lasna ${link(5318007, last.lasna_tx)} → gate U ${link(1301, last.gate_u_tx)} · gate B ${link(84532, last.gate_b_tx)}. No setup needed.</p>` : "") +
    `<p><b>Hands-on:</b> <span class="mono">scripts/bench.ts</span> and <span class="mono">script/core-trigger.sh</span>. Needs your own funded testnet keys; setup in DEMO.md.</p>`;
}

(async function main() {
  let d;
  try { d = await (await fetch("data/status.json", { cache: "no-store" })).json(); } catch { $("routes").innerHTML = '<p class="empty">data/status.json could not be loaded.</p>'; document.body.classList.remove("loading"); return; }
  const none = { gateB: null, gateU: null, rs: null, balRc: null, balB: null, balU: null };
  render(d, none);
  evidence(d);
  document.body.classList.remove("loading");
  drawCharts();
  const lv = await Promise.race([live(d), new Promise((r) => setTimeout(() => r(none), 8000))]);
  PENDING = false;
  render(d, lv);
})();
