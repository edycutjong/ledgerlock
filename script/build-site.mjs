#!/usr/bin/env node
// Builds the GitHub Pages site: copies docs/ to an output dir, stamps the latest release tag into every element that
// carries a `data-release` attribute, and fails if any local href/src in any page does not resolve to a file.
// Usage: node script/build-site.mjs [src=docs] [out=_site]
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const [src = "docs", out = "_site"] = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

let tag = "";
try {
  tag = execSync("git describe --tags --abbrev=0", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  /* no tags: keep the committed text */
}
if (tag && !/^v\d+\.\d+\.\d+$/.test(tag)) tag = "";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = walk(out).filter((f) => f.endsWith(".html"));
const missing = [];
let stamped = 0;

// A local target resolves the way GitHub Pages serves it: the file, then `<path>.html`, then `<path>/index.html`.
const resolves = (p) =>
  (existsSync(p) && statSync(p).isFile()) || existsSync(`${p}.html`) || existsSync(join(p, "index.html"));

for (const page of pages) {
  let html = readFileSync(page, "utf8");
  if (tag) {
    html = html.replace(/(<[^>]*\bdata-release\b[^>]*>)v\d+\.\d+\.\d+(<\/)/g, (_, open, close) => {
      stamped++;
      return `${open}${tag}${close}`;
    });
    writeFileSync(page, html);
  }
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue; // external, data:, mailto:, in-page anchor
    const path = decodeURIComponent(url.split(/[?#]/)[0]);
    if (!path) continue;
    const target = path.startsWith("/") ? join(out, path) : resolve(dirname(page), path);
    if (!resolves(target)) missing.push(`${relative(out, page)} -> ${url}`);
  }
}

console.log(`site: ${pages.length} pages copied to ${out}/; release tag ${tag || "(none, committed text kept)"} stamped into ${stamped} elements`);
if (missing.length) {
  console.error(`broken local links (${missing.length}):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log("site: every local href/src resolves");
