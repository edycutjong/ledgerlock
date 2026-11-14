// Latest release tag: every [data-release] element already shows the tag stamped at deploy time (script/build-site.mjs);
// this refreshes it from the GitHub API if a newer release exists. One shared cache for every page of the site (localStorage,
// 1 hour), and a failed or rate-limited call is cached too, so a visitor on a shared IP asks the API at most once an hour
// instead of once per page. /rate_limit is asked first: it answers 200 even when the IP's quota is spent and does not count
// against it, so an exhausted quota skips the release call instead of logging a 403. Fails silently: the stamped tag stays.
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
  const API = "https://api.github.com", H = { headers: { Accept: "application/vnd.github+json" } };
  fetch(API + "/rate_limit", H)
    .then((r) => (r.ok ? r.json() : null))
    .then((q) => {
      if (q && q.resources && q.resources.core && q.resources.core.remaining === 0) return null; // quota spent: skip, no 403
      return fetch(API + "/repos/edycutjong/ledgerlock/releases/latest", H).then((r) => (r.ok ? r.json() : null));
    })
    .then((j) => { const t = j && j.tag_name; store(ok(t) ? t : null); paint(t); })
    .catch(() => store(null));
})();
