// pages.test.ts: the search pages are generated, not written by hand. If dist/<slug>.html is not exactly what
// tools/pages.ts makes from dist/index.html and pages/<slug>.json today, this fails — a fix to the home page that was
// not carried to the pages, or a page someone edited by hand, stops the build before it reaches a visitor.
// Both tools carry the same copy of this file (tests/site.test.ts: "shared parts are the same file in every tool").
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderPage, readPages } from "../tools/pages";

const APP = join(import.meta.dir, "..");
const index = readFileSync(join(APP, "dist/index.html"), "utf8");
const pages = readPages(APP);
const styles = (html: string) => [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((m) => m[0]).join("\n");

test("every search page is what the generator makes from the home page today", () => {
  for (const p of pages) expect(readFileSync(join(APP, `dist/${p.slug}.html`), "utf8"), `dist/${p.slug}.html is stale — run ./build.sh`).toBe(renderPage(index, p));
});

test("dist holds exactly the pages that pages/ names", () => {
  const OWN = /^(index|studio|privacy|terms|google[0-9a-f]+)\.html$/; // the hand-written pages of this tool
  const made = readdirSync(join(APP, "dist")).filter((f) => f.endsWith(".html") && !OWN.test(f)).sort();
  expect(made, "a generated page whose json is gone, or a json with no page").toEqual(pages.map((p) => `${p.slug}.html`).sort());
});

test("every search page carries the home page's version stamps, its styles and its price and key boxes", () => {
  // build.sh stamps dist/index.html and then generates; a page built the other way round would serve a stale script.
  const stamp = index.match(/src="app\.js\?v=(\d+)"/)?.[1];
  expect(stamp, "the home page is stamped").toBeTruthy();
  const media = [...index.matchAll(/(sample\.mp4|poster\.(?:jpg|webp)|sample-words\.json)\?v=(\d+)/g)].map((m) => m[0]).sort();
  for (const p of pages) {
    const html = readFileSync(join(APP, `dist/${p.slug}.html`), "utf8");
    expect(html, `${p.slug}: the script stamp`).toContain(`src="app.js?v=${stamp}"`);
    expect([...html.matchAll(/(sample\.mp4|poster\.(?:jpg|webp)|sample-words\.json)\?v=(\d+)/g)].map((m) => m[0]).sort(), `${p.slug}: the media stamps`).toEqual(media);
    expect(styles(html), `${p.slug}: one look with the home page`).toBe(styles(index));
    expect(html, `${p.slug}: the price box`).toContain('<div class="price" id="price">');
    expect(html, `${p.slug}: the key box`).toContain('<div class="key" id="keyrow">');
    expect(html, `${p.slug}: the sample and the main button`).toContain('<button class="btn primary" id="action">');
  }
});
