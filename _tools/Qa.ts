// Qa.ts: deterministic page audit for a mission's public page. Real Chromium, three contexts
// (desktop light, phone light, desktop dark). Writes screenshots and qa.json, prints a table,
// exits 1 when a blocking rule fails. Judgement (is it good to use?) is the agents' job in
// Workflows/Quality.md; this tool only measures what can be measured.
//
//   bun Qa.ts <url> [--out <dir>] [--grade 7] [--json]
//
// Blocking rules (each one has a why in Workflows/Quality.md):
//   console errors > 0 · failed or 4xx/5xx requests > 0 · sideways scroll · tap target under 44 px on phone
//   body text under 15 px on phone · reading grade above --grade (default 7) · buttons disabled at rest > 0
//   no media (img/video/canvas over 120x120) in the first phone screen · LCP over 2.5 s
import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
if (!url) { console.error("usage: bun Qa.ts <url> [--out dir] [--grade 7] [--json]"); process.exit(2); }
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt("--out", "assets/verification/qa"); const maxGrade = Number(opt("--grade", "7")); const asJson = args.includes("--json");
mkdirSync(out, { recursive: true });

type Ctx = { name: string; viewport: { width: number; height: number }; isMobile?: boolean; colorScheme?: "light" | "dark"; deviceScaleFactor?: number; hasTouch?: boolean };
const contexts: Ctx[] = [
  { name: "desktop-light", viewport: { width: 1280, height: 900 }, colorScheme: "light" },
  { name: "phone-light", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "light" },
  { name: "desktop-dark", viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
];

function syllables(w: string) { w = w.toLowerCase().replace(/[^a-z]/g, ""); if (!w) return 0; if (w.length <= 3) return 1; w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, ""); return Math.max(1, (w.match(/[aeiouy]{1,2}/g) ?? []).length); }
function fkGrade(text: string) {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)); if (words.length < 20) return 0;
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  return Math.round((0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59) * 10) / 10;
}

async function audit(page: Page, c: Ctx) {
  const consoleErrors: string[] = []; const failed: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 200)));
  page.on("requestfailed", (r) => { if (/cloudflareinsights\.com/.test(r.url())) return; if (r.resourceType() === "media" && /ABORTED/.test(r.failure()?.errorText ?? "")) return; failed.push("FAILED " + r.url()); }); // a paused, unloaded or replaced video cancels its own download
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => { try { new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {} });
  const t0 = Date.now();
  await page.goto(url!, { waitUntil: "networkidle", timeout: 60000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(500);
  const dom = await page.evaluate(({ vh }) => {
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const inFold = (el: Element) => { const r = el.getBoundingClientRect(); return r.top < vh && r.bottom > 0; };
    const controls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, label.drop, [role=button]")].filter(vis);
    const targets = controls.map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }));
    const buttons = [...document.querySelectorAll("button")].filter(vis);
    const disabledAtRest = buttons.filter((b) => b.disabled).map((b) => b.textContent?.trim().slice(0, 30));
    const selects = [...document.querySelectorAll("select")].filter(vis).length;
    const textEls = [...document.querySelectorAll("p, li, span, label, div, a, button, h1, h2, h3, small")].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 2));
    const small = textEls.map((el) => ({ px: parseFloat(getComputedStyle(el).fontSize), text: (el.textContent ?? "").trim().slice(0, 40) })).filter((t) => t.px < 15);
    const media = [...document.querySelectorAll("img, video, canvas, svg, picture")].filter((el) => { const r = el.getBoundingClientRect(); return vis(el) && r.width >= 120 && r.height >= 120 && inFold(el); }).length;
    // A row of sibling cards (same parent, same class, same top) must line up: equal heights and their last button on one line. Learned on the studio page 2026-09-18 (floated posters inside flex cards, buttons at different heights).
    const rows = []; for (const parent of new Set([...document.querySelectorAll("[class]")].map((e) => e.parentElement).filter(Boolean))) { const kids = [...parent.children].filter((k) => vis(k) && typeof k.className === "string" && k.className.trim()); const byClass = new Map(); for (const k of kids) { const key = k.className.trim().split(/\s+/)[0]; if (!byClass.has(key)) byClass.set(key, []); byClass.get(key).push(k); } for (const [key, group] of byClass) { if (group.length < 2) continue; const rects = group.map((k) => k.getBoundingClientRect()); if (!rects.every((r) => Math.abs(r.top - rects[0].top) < 2)) continue; const hs = rects.map((r) => Math.round(r.height)); const bots = group.map((k) => { const b = [...k.querySelectorAll("button, a.btn, [role=button]")].filter(vis).pop(); return b ? Math.round(b.getBoundingClientRect().bottom) : null; }); const hDiff = Math.max(...hs) - Math.min(...hs); const bs = bots.filter((b) => b !== null); const bDiff = bs.length > 1 ? Math.max(...bs) - Math.min(...bs) : 0; if (hDiff > 6 || bDiff > 6) rows.push(`.${key} x${group.length} heights ${hs.join("/")} button bottoms ${bots.join("/")}`); } }
    const sideways = document.documentElement.scrollWidth > window.innerWidth + 1;
    // The main button of a tool page (the first .btn.primary) must sit whole inside the first screen, on every screen size. Learned on Captions
    // 2026-09-19: at 1440 x 900 the stage was 78% of the height and "Use my own clip" sat 106 px below the fold; two reviewers found it, the audit had not.
    const main = [...document.querySelectorAll(".btn.primary")].find((b) => vis(b)); const mainAction = main ? { text: (main.textContent ?? "").trim().slice(0, 40), bottom: Math.round(main.getBoundingClientRect().bottom), fold: window.innerHeight } : null;
    const text = document.body.innerText ?? "";
    const lcp = (window as any).__lcp ?? null;
    const bytes = (performance.getEntriesByType("resource") as any[]).reduce((a, e) => a + (e.transferSize || 0), 0) + ((performance.getEntriesByType("navigation")[0] as any)?.transferSize || 0);
    const bg = getComputedStyle(document.body).backgroundColor; const fg = getComputedStyle(document.body).color;
    return { targets, disabledAtRest, selects, small, mediaInFold: media, rows, sideways, mainAction, text, lcp, bytes, bg, fg, title: document.title };
  }, { vh: c.viewport.height });
  const shot = join(out, `${c.name}.png`); await page.screenshot({ path: shot, fullPage: true });
  const fold = join(out, `${c.name}-fold.png`); await page.screenshot({ path: fold, fullPage: false });
  const grade = fkGrade(dom.text);
  const minTarget = Math.min(...dom.targets.map((t) => t.h), 999);
  const blockers: string[] = [];
  if (consoleErrors.length) blockers.push(`${consoleErrors.length} console error(s)`);
  if (failed.length) blockers.push(`${failed.length} failed/4xx/5xx request(s)`);
  if (dom.sideways) blockers.push("page scrolls sideways");
  if (c.isMobile && minTarget < 44) blockers.push(`tap target ${minTarget} px tall (min 44)`);
  if (c.isMobile && dom.small.length) blockers.push(`${dom.small.length} text element(s) under 15 px`);
  if (grade > maxGrade) blockers.push(`reading grade ${grade} (max ${maxGrade})`);
  const words = dom.text.split(/\s+/).filter(Boolean).length; if (words > 240) blockers.push(`too many words: ${words} (max 240 at rest; the principal: "so many words")`);
  if (dom.disabledAtRest.length) blockers.push(`${dom.disabledAtRest.length} button(s) disabled at rest: ${dom.disabledAtRest.join(", ")}`);
  if (c.isMobile && dom.mediaInFold === 0) blockers.push("no image/video/canvas in the first phone screen");
  if (dom.mainAction && dom.mainAction.bottom > dom.mainAction.fold) blockers.push(`the main button "${dom.mainAction.text}" ends ${dom.mainAction.bottom - dom.mainAction.fold} px below the first screen`);
  if (dom.rows?.length) blockers.push(`row of cards misaligned: ${dom.rows.join(" | ")}`);
  if (dom.lcp !== null && dom.lcp > 2500) blockers.push(`LCP ${Math.round(dom.lcp)} ms (max 2500)`);
  return { context: c.name, url, loadMs, lcpMs: dom.lcp === null ? null : Math.round(dom.lcp), transferKB: Math.round(dom.bytes / 1024), grade, words: dom.text.split(/\s+/).filter(Boolean).length, minTargetPx: minTarget, smallText: dom.small.slice(0, 8), disabledAtRest: dom.disabledAtRest, nativeSelects: dom.selects, mediaInFold: dom.mediaInFold, sideways: dom.sideways, consoleErrors, failedRequests: failed, screenshots: [shot, fold], blockers };
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = [] as Awaited<ReturnType<typeof audit>>[];
for (const c of contexts) {
  const ctx = await browser.newContext({ viewport: c.viewport, isMobile: c.isMobile, hasTouch: c.hasTouch, deviceScaleFactor: c.deviceScaleFactor, colorScheme: c.colorScheme });
  await ctx.route(/cloudflareinsights\.com/, (r) => r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })); // our own visits stay out of the visitor numbers; the beacon script loads as it is (it carries an integrity check, so an emptied copy prints a console error, and so does an aborted one) and only the report it posts is answered here (2026-09-19: of 355 page loads in a week, about 340 were audits, gates and reviewers)
  const page = await ctx.newPage();
  try { results.push(await audit(page, c)); } catch (e: any) { results.push({ context: c.name, url, blockers: ["audit failed: " + (e?.message ?? e)] } as any); }
  await ctx.close();
}
await browser.close();
const totalBlockers = results.reduce((a, r) => a + r.blockers.length, 0);
const report = { url, at: new Date().toISOString(), maxGrade, totalBlockers, results };
writeFileSync(join(out, "qa.json"), JSON.stringify(report, null, 2));
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`QA ${url}  blockers=${totalBlockers}  (${join(out, "qa.json")})`);
  for (const r of results) {
    console.log(`\n[${r.context}] load ${r.loadMs ?? "?"} ms · LCP ${r.lcpMs ?? "?"} ms · ${r.transferKB ?? "?"} KB · grade ${r.grade ?? "?"} · ${r.words ?? "?"} words · min tap ${r.minTargetPx ?? "?"} px · media in fold ${r.mediaInFold ?? "?"} · selects ${r.nativeSelects ?? "?"}`);
    for (const b of r.blockers) console.log("  BLOCK " + b);
    for (const e of r.consoleErrors ?? []) console.log("  console: " + e);
    for (const f of r.failedRequests ?? []) console.log("  request: " + f);
    for (const s of r.smallText ?? []) console.log(`  small ${s.px}px: ${s.text}`);
  }
}
process.exit(totalBlockers ? 1 : 0);
