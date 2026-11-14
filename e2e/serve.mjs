// Zero-dependency static server for the Pages site, resolving paths the way GitHub Pages does:
// the file, then `<path>.html`, then `<path>/index.html`; a directory without a trailing slash redirects to it.
// Usage: SITE_DIR=_site PORT=4173 node e2e/serve.mjs   (SITE_DIR defaults to docs/)
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.env.SITE_DIR || "docs");
const port = Number(process.env.PORT || 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const isFile = (p) => existsSync(p) && statSync(p).isFile();

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const base = join(root, rel);
  if (!base.startsWith(root)) { res.writeHead(403).end(); return; }
  if (existsSync(base) && statSync(base).isDirectory() && !url.pathname.endsWith("/")) {
    res.writeHead(301, { Location: url.pathname + "/" }).end(); return;
  }
  const file = [base, `${base}.html`, join(base, "index.html")].find(isFile);
  if (!file) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
