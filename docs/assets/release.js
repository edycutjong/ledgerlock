// Latest release tag: every [data-release] element already shows the tag stamped at deploy time (script/build-site.mjs);
// this refreshes it from the GitHub API if a newer release exists. Cached for 10 minutes; fails silently.
(() => {
  const els = document.querySelectorAll("[data-release]");
  if (!els.length) return;
  const KEY = "ledgerlock-release", ok = (t) => typeof t === "string" && /^v\d+\.\d+\.\d+$/.test(t);
  const paint = (t) => { if (ok(t)) els.forEach((e) => { e.textContent = t; }); };
  try {
    const c = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (c && Date.now() - c.at < 600000) return paint(c.tag);
  } catch { /* storage unavailable */ }
  fetch("https://api.github.com/repos/edycutjong/ledgerlock/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const t = j && j.tag_name;
      if (!ok(t)) return;
      paint(t);
      try { sessionStorage.setItem(KEY, JSON.stringify({ tag: t, at: Date.now() })); } catch { /* ignore */ }
    })
    .catch(() => {});
})();
