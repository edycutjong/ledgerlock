// Latest release tag: every [data-release] element already shows the tag stamped at deploy time (script/build-site.mjs);
// this refreshes it from the GitHub API if a newer release exists. One shared cache for every page of the site (localStorage,
// 1 hour), and a failed or rate-limited call is cached too, so a visitor on a shared IP asks the API at most once an hour
// instead of once per page. Fails silently: the stamped tag stays.
(() => {
  const els = document.querySelectorAll("[data-release]");
  if (!els.length) return;
  const KEY = "ledgerlock-release-v2", TTL = 3600000, ok = (t) => typeof t === "string" && /^v\d+\.\d+\.\d+$/.test(t);
  const paint = (t) => { if (ok(t)) els.forEach((e) => { e.textContent = t; }); };
  const store = (tag) => { try { localStorage.setItem(KEY, JSON.stringify({ tag, at: Date.now() })); } catch { /* storage unavailable */ } };
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (c && Date.now() - c.at < TTL) return paint(c.tag); // a cached miss (tag null) keeps the stamped text
  } catch { /* storage unavailable */ }
  fetch("https://api.github.com/repos/edycutjong/ledgerlock/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { const t = j && j.tag_name; store(ok(t) ? t : null); paint(t); })
    .catch(() => store(null));
})();
