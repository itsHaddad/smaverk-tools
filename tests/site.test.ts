// site.test.ts: the ripple check. When one thing changes, the other places that state the same fact must change with it
// (the principal, 2026-09-18: a studio page whose Privacy link opened another tool's policy, a terms page still describing
// a feature as unfinished, "never" promises). No browser: runs in `bun test tests/` locally, in deploy.sh and on the runner.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
// A tool joins this list the day it gets a page, and every check below then applies to it. Every tool is free (A, 2026-10-17:
// Polar showed no order in 60 days, and the tools run on the visitor's device), so no page states a price and none has a
// key box; one optional support payment is linked from every page. `limits` are the sentences that must appear wherever a
// searcher can land, since a limit discovered after the work is done is what earns one-star reviews. `copy` is where the
// page's own sentences live.
const SITES = {
  captions: { dist: "captions/app/dist", src: ["captions/app/app.ts", "captions/app/worker.ts"], limits: ["five minutes"], page: "index.html", host: "captions.smaverk.com", copy: "captions/app/app.ts" },
  vertical: { dist: "vertical/app/dist", src: ["vertical/app/app.ts", "vertical/app/src/detect.ts", "vertical/app/src/fastsave.ts"], limits: ["five minutes"], page: "index.html", host: "vertical.smaverk.com", copy: "vertical/app/app.ts" },
  clipfinder: { dist: "clipfinder/app/dist", src: ["clipfinder/app/app.ts", "clipfinder/app/worker.ts"], limits: ["four hours"], page: "index.html", host: "clipfinder.smaverk.com", copy: "clipfinder/app/app.ts" },
  clips: { dist: "clips/app/dist", src: ["clips/app/app.ts", "clips/app/src/make.ts", "clips/app/src/lib/plan.ts"], limits: ["90 seconds", "four hours"], page: "index.html", host: "clips.smaverk.com", copy: "clips/app/app.ts" },
} as const;
// The one optional payment (Polar product "Support Småverk", the visitor picks the amount, one time, no benefit), and the
// two pieces every tool page carries byte for byte: "Free" in the header, and one quiet support line.
const SUPPORT = "https://buy.polar.sh/polar_cl_dDSll8mftHzvbuFi5j0OMjqduigiYhMEw4NIm3HTCkb";
const FREE_TAG = '<a class="tag" id="tag" href="#support"><b>Free</b></a>';
const SUPPORT_LINE = '<p class="fine" id="support">Free. If it helped you, you can <a href="https://buy.polar.sh/polar_cl_dDSll8mftHzvbuFi5j0OMjqduigiYhMEw4NIm3HTCkb" target="_blank" rel="noopener">support Småverk</a>.</p>';
// studio.html is the video tools' page (video.smaverk.com) and home.html is smaverk.com, Maindesk's page (A, 27 Oct 2026).
const STUDIO = "captions/app/dist/studio.html"; const HOME = "captions/app/dist/home.html"; const LEGAL = ["captions/app/dist/privacy.html", "captions/app/dist/terms.html"];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const pages = () => Object.values(SITES).flatMap((s) => readdirSync(join(ROOT, s.dist)).filter((f) => /\.(html|txt)$/.test(f) && !/^google/.test(f)).map((f) => `${s.dist}/${f}`));
// The search pages (tools/pages.ts): every .html in a dist that is not one of the tool's hand-written pages.
const HAND = /^(index|studio|home|privacy|terms|google[0-9a-f]+)\.html$/;
const search = (s: { dist: string }) => readdirSync(join(ROOT, s.dist)).filter((f) => f.endsWith(".html") && !HAND.test(f));
const every = (s: { dist: string; page: string }) => [s.page, ...search(s)]; // the home page and its search pages
// What a visitor reads without touching anything: no script, style or svg, nothing hidden, no display:none block
// (.steps, .result) and no closed <details> body — the answers are in the page for readers who open them and for search
// engines, and they do not count against the budget. Summaries do. Tags are word boundaries, as a reader sees them.
const atRest = (html: string) => {
  const body = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  const SKIP = new Set(["script", "style", "svg", "noscript", "template"]);
  const stack: { tag: string; skip: boolean; details: boolean }[] = []; let out = "", i = 0, skipping = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i); if (lt < 0) { if (!skipping) out += body.slice(i); break; }
    if (!skipping) out += body.slice(i, lt) + " ";
    const gt = body.indexOf(">", lt); if (gt < 0) break;
    const raw = body.slice(lt + 1, gt); i = gt + 1;
    if (raw.startsWith("!")) continue;
    if (raw.startsWith("/")) { const t = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k]!.tag === t) { if (stack[k]!.skip) skipping--; stack.length = k; break; }
      continue; }
    const tag = raw.split(/[\s/>]/)[0]!.toLowerCase();
    if (raw.endsWith("/") || ["img", "input", "br", "hr", "meta", "link", "source"].includes(tag)) continue;
    const attrs = raw.slice(tag.length);
    const closed = stack.some((f) => f.details) && tag !== "summary" && !stack.some((f) => f.tag === "summary");
    const skip = SKIP.has(tag) || /\shidden(\s|=|$)/.test(attrs) || /class="[^"]*\b(steps|result)\b/.test(attrs) || closed;
    if (skip) skipping++;
    stack.push({ tag, skip, details: tag === "details" });
  }
  return out.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
};
const wordsAtRest = (html: string) => atRest(html).split(/\s+/).filter(Boolean).length;
// Where a link on one of our pages lands, as a file in a dist, or null when it points off our sites.
const fileFor = (href: string, host: string) => {
  const u = new URL(href, `https://${host}/`);
  const site = Object.values(SITES).find((s) => s.host === u.hostname); if (!site) return null;
  let p = u.pathname === "/" ? "/index.html" : u.pathname; if (!/\.[a-z]+$/.test(p)) p += ".html";
  return existsSync(join(ROOT, site.dist + p)) ? site.dist + p : `MISSING ${site.dist}${p}`;
};
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
const code = (ts: string) => ts.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, " ");

test("no permanence wording in anything a visitor reads (never, ever, forever)", () => {
  const hits: string[] = [];
  for (const p of pages()) for (const m of text(read(p)).matchAll(/[^.]{0,40}\b(never|forever|ever)\b[^.]{0,30}/gi)) hits.push(`${p}: …${m[0].trim()}…`);
  for (const s of Object.values(SITES)) for (const f of s.src) if (existsSync(join(ROOT, f))) for (const m of code(read(f)).matchAll(/["'`][^"'`\n]*\b(never|forever|ever)\b[^"'`\n]*["'`]/gi)) hits.push(`${f}: ${m[0].slice(0, 90)}`);
  expect(hits).toEqual([]);
});

test("no permanence wording in the drafts the principal will paste (the > lines in */assets/marketing/*.md)", () => {
  // The principal's rule covers posts and listings as well as pages ("no 'no subscription, ever' on pages or in drafts").
  // Paste-ready text in a draft file is written as a > blockquote; notes to the principal around it are not checked.
  const hits: string[] = [];
  for (const d of readdirSync(ROOT)) { const dir = join(ROOT, d, "assets", "marketing"); if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) for (const line of read(`${d}/assets/marketing/${f}`).split("\n"))
      if (/^>/.test(line) && /\b(never|forever|ever)\b/i.test(line)) hits.push(`${d}/assets/marketing/${f}: ${line.slice(0, 90)}`); }
  expect(hits).toEqual([]);
});

test("Privacy and Terms links open the studio's own pages, from every page", () => {
  const bad: string[] = [];
  // Maindesk keeps its own Terms and Privacy (A, 27 Oct 2026: the studio presents it); the studio's own two pages point
  // a Maindesk reader there, and no other page may.
  const own = (p: string, href: string) => /^https:\/\/smaverk\.com\/(privacy|terms)$/.test(href) || (LEGAL.includes(p) && /^https:\/\/maindesk\.smaverk\.com\/(privacy|terms)$/.test(href));
  for (const p of pages()) for (const m of read(p).matchAll(/href="([^"]*\b(privacy|terms)\b[^"]*)"/g)) if (!own(p, m[1]!)) bad.push(`${p}: ${m[1]}`);
  expect(bad).toEqual([]);
  for (const l of LEGAL) { const h = read(l); expect(h).toContain(`<link rel="canonical" href="https://smaverk.com/`); for (const tool of ["Captions", "Vertical"]) expect(h).toContain(tool); }
});

// 2026-09-29: the gates had no usage data (Cloudflare samples at 10% and cannot see use), so every page loads the first-party
// count script (missions/events) and the privacy page says what it counts.
test("every page loads the Småverk count script, and the privacy page says what it counts", () => {
  const missing = pages().filter((f) => f.endsWith(".html") && !read(f).includes(`<script src="https://events.smaverk.com/c.js" defer></script>`));
  expect(missing).toEqual([]);
  expect(text(read(LEGAL[0]!))).toMatch(/We also count, per day, how often a tool is opened, a file is picked, a result is saved or shared, and the support link is tapped/);
  expect(text(read(LEGAL[0]!))).toMatch(/only the country and whether it came from a phone or a computer/); // what D1 stores beside each count (events/schema.sql)
});

test("pages load nothing from other companies except the analytics beacon", () => {
  const bad: string[] = [];
  for (const p of pages().filter((f) => f.endsWith(".html"))) for (const m of read(p).matchAll(/<(?:script|link|img|video|source|iframe)\b[^>]*\b(?:src|href)=["'](https?:\/\/[^"']+)["'][^>]*>/g)) {
    const tag = m[0]!, url = m[1]!; if (/rel="canonical"|rel="alternate"/.test(tag)) continue;
    if (!/^https:\/\/(static\.cloudflareinsights\.com|([a-z]+\.)?smaverk\.com)\//.test(url)) bad.push(`${p}: ${url}`);
  }
  expect(bad).toEqual([]);
});

test("every outside address the scripts contact is accounted for in the privacy page", () => {
  // Add a host here only after the privacy page says what is sent to it, in plain words.
  const KNOWN: Record<string, RegExp> = { "captions.smaverk.com": /./, "vertical.smaverk.com": /./, "clipfinder.smaverk.com": /./, "clips.smaverk.com": /./, "smaverk.com": /./ };
  const privacy = text(read(LEGAL[0]!)); const unknown: string[] = [];
  for (const s of Object.values(SITES)) for (const f of s.src) if (existsSync(join(ROOT, f))) for (const m of code(read(f)).matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) { const h = m[1]!; if (!KNOWN[h]) unknown.push(`${f}: ${h}`); else expect(privacy).toMatch(KNOWN[h]!); }
  expect(unknown).toEqual([]);
  expect(privacy).toMatch(/Cloudflare Web Analytics/); // the beacon is named; it is the one party that sees page visits
  // The tools fetch some of their files from public file hosts. The page says so as a category (the principal, 2026-09-18: do not
  // tell the world how the tools are built); it must keep saying so until every file is served from our own site.
  expect(privacy).toMatch(/public file hosts/);
});

test("every tool is free: no page, llms.txt, script or legal page states a price, and JSON-LD offers it at 0", () => {
  const found: string[] = [];
  const pagesRead = [...Object.values(SITES).flatMap((s) => [...every(s), "llms.txt"].map((f) => `${s.dist}/${f}`)), STUDIO, ...LEGAL, "operator/app/dist/index.html", "operator/app/dist/llms.txt"].filter((p) => existsSync(join(ROOT, p)));
  // A rival's price is always written "$N a month" (we charge nothing), so that form is theirs, not one of ours.
  for (const p of pagesRead) for (const m of text(read(p)).replace(/\$\d+ a month/g, " ").matchAll(/\$\d+/g)) found.push(`${p}: ${m[0]}`);
  for (const s of Object.values(SITES)) for (const f of s.src) for (const m of code(read(f)).matchAll(/["'`][^"'`\n]*\$\d+[^"'`\n]*["'`]/g)) if (!/\$\{/.test(m[0]!)) found.push(`${f}: ${m[0].slice(0, 80)}`);
  expect(found).toEqual([]);
  for (const p of [...Object.values(SITES).flatMap((s) => every(s).map((f) => `${s.dist}/${f}`)), "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)))) {
    const offers = [...read(p).matchAll(/"offers":(\{[^}]*\})/g)].map((m) => JSON.parse(m[1]!));
    expect(offers.length, `${p}: one offer in the JSON-LD`).toBe(1);
    expect(offers[0], p).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free" });
  }
});

test("every limit a tool enforces is stated wherever a searcher can land", () => {
  // Hidden limits earn one-star reviews (Kapwing, Trustpilot, 12 Apr 2026), so each tool's own limits are
  // on every page of it, in what agents read, and in the script that enforces them.
  for (const s of Object.values(SITES)) for (const f of every(s)) { const t = text(read(`${s.dist}/${f}`)) + code(read(s.src[0]!)); for (const limit of s.limits) expect(t, `${s.dist}/${f}: ${limit}`).toMatch(new RegExp(limit, "i")); }
  const terms = text(read(LEGAL[1]!)); expect(terms).toMatch(/five minutes/); expect(terms).toMatch(/four hours/); expect(terms).toMatch(/90 seconds/); expect(terms).not.toMatch(/60 seconds|30 minutes/); expect(terms).not.toMatch(/being finished|estimate/);
  // Every tool is named in both legal pages: one of them described a tool that did not exist yet, once.
  for (const l of LEGAL) for (const tool of ["Captions", "Vertical", "Clip finder", "Clips"]) expect(text(read(l)), `${l} names ${tool}`).toContain(tool);
});

test("each sitemap lists only pages on its own host", () => {
  const check = (file: string, host: string) => { for (const m of read(file).matchAll(/<loc>https:\/\/([^/<]+)/g)) expect(`${file}: ${m[1]}`).toBe(`${file}: ${host}`); };
  check("captions/app/dist/sitemap.xml", "captions.smaverk.com"); check("captions/app/dist/studio-sitemap.xml", "smaverk.com"); check("captions/app/dist/video-sitemap.xml", "video.smaverk.com"); check("clipfinder/app/dist/sitemap.xml", "clipfinder.smaverk.com"); check("clips/app/dist/sitemap.xml", "clips.smaverk.com");
});

test("the tools share one look: every style rule both pages have is identical, apart from the named exceptions", () => {
  // The principal, 2026-09-18: "Sound off now is different from how it is in the captions video, so now we have two styles."
  // A shared control is changed in both tools in the same commit. Exceptions are differences with a reason, written here.
  const ALLOWED = new Set([".demo", ".stage", ".chips", ".chip", ".stage video"]); // clip shape (9:16 vs 16:9), three picture chips vs two word chips, Vertical's video ignores taps
  const rules = (file: string) => { const css = [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/@media[^{]+\{([\s\S]*?\})\s*\}/g, " "); const out = new Map<string, string>(); for (const r of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) for (const sel of r[1]!.split(",")) out.set(sel.trim(), r[2]!.trim().replace(/;$/, "")); return out; };
  const a = rules("captions/app/dist/index.html"), b = rules("vertical/app/dist/index.html"); const drift: string[] = []; let shared = 0;
  for (const [sel, body] of a) if (b.has(sel)) { shared++; if (b.get(sel) !== body && !ALLOWED.has(sel)) drift.push(sel); }
  expect(shared).toBeGreaterThan(60); expect(drift).toEqual([]);
  const soundMarkup = (file: string) => read(file).match(/<button class="sound" id="sound"[\s\S]*?<\/button>/)?.[0];
  expect(soundMarkup("captions/app/dist/index.html")).toBe(soundMarkup("vertical/app/dist/index.html")!);
});

test("nothing a visitor reads says how the tools are built", () => {
  // The principal, 2026-09-18: "we dont want to give away how we do what we do ... talk about privacy in general."
  // Pages, llms.txt and the sentences in the scripts say what a tool does for the person, not which technology does it.
  const METHOD = /\b(whisper|webgpu|wasm|webassembly|webcodecs|mediapipe|blazeface|hugging ?face|jsdelivr|onnx|transformers(\.js)?|tensorflow|mediabunny|ffmpeg|speech model|speech recognition|language model|neural|machine learning|face (tracker|detector|detection)|largest face|h\.?264|vp9|opus)\b/i;
  const hits: string[] = [];
  for (const p of pages()) for (const line of text(read(p)).split(/\n|(?<=[.!?])\s/)) { const m = line.match(METHOD); if (m) hits.push(`${p}: "${m[0]}" in …${line.trim().slice(0, 90)}`); }
  for (const s of Object.values(SITES)) { const f = s.src[0]!; for (const m of code(read(f)).matchAll(/["'`]([^"'`\n]* [^"'`\n]* [^"'`\n]*)["'`]/g)) { const sentence = m[1]!; if (/^Debug:|\$\{navigator\.userAgent\}/.test(sentence)) continue; const hit = sentence.match(METHOD); if (hit) hits.push(`${f}: "${hit[0]}" in ${sentence.slice(0, 90)}`); } }
  expect(hits).toEqual([]);
});

test("only files whose names change with their content are cached as immutable", () => {
  // 2026-09-18: sample.mp4 was replaced twice and visitors kept getting the first one, because /sample.mp4 was "immutable" for a year.
  const OK = /^\/(mediapipe|models)\/\*$/; // versioned by the library that ships them
  for (const s of Object.values(SITES)) { const lines = read(`${s.dist}/_headers`).split("\n"); let path = "";
    for (const l of lines) { if (/^\S/.test(l)) path = l.trim(); else if (/immutable/.test(l)) expect(`${s.dist}: ${path}`).toMatch(new RegExp(`: ${OK.source.slice(1, -1)}$`)); } }
  for (const f of ["vertical/app/app.ts", "captions/app/app.ts"]) expect(read(f)).toMatch(/"sample\.mp4" \+ ASSET_V/);
});

test("shared parts are the same file in every tool", () => {
  expect(read("captions/app/src/seek.ts")).toBe(read("vertical/app/src/seek.ts"));
  // The search-page generator, its test and the local server are one file with two copies: a fix belongs in both.
  for (const f of ["tools/pages.ts", "tests/pages.test.ts", "serve.ts"]) expect(read(`captions/app/${f}`), f).toBe(read(`vertical/app/${f}`));
  const seekMarkup = (file: string) => read(file).match(/<input class="seek"[^\n]*/)?.[0];
  expect(seekMarkup("captions/app/dist/index.html")).toBe(seekMarkup("vertical/app/dist/index.html")!);
  // Clips plays its clip in the same stage player (design review r8 C1): no browser controls, the same sound button, play
  // disc, tap layer and scrub line, the same seek.ts, and the same CSS rules for them as Captions.
  const clips = read("clips/app/dist/index.html"), cap = read("captions/app/dist/index.html");
  expect(read("clips/app/src/seek.ts"), "Clips scrubs with the same line").toBe(read("captions/app/src/seek.ts"));
  expect(seekMarkup("clips/app/dist/index.html")).toBe(seekMarkup("captions/app/dist/index.html")!);
  for (const re of [/<button class="sound" id="sound"[\s\S]*?<\/button>/, /<button class="tap" id="tap"[^>]*><\/button>/, /<div class="play" id="playicon">[\s\S]*?<\/div>/])
    expect(clips.match(re)?.[0], String(re)).toBe(cap.match(re)?.[0]!);
  expect(clips, "the browser's own controls are not on the clip").not.toMatch(/<video id="reel"[^>]*\bcontrols\b/);
  expect(clips).toMatch(/<div class="reel stage" id="reelwrap">\s*<video id="reel"/);
  const stageRules = (html: string) => [...html.matchAll(/(?<=[}\n])(\.stage(?:\.playing)? \.(?:tap|play|sound|seek|seekbar)\b[^{]*\{[^}]*\})/g)].map((m) => m[1]).filter((r) => !/\.stage\.busy|data-side/.test(r!));
  expect(stageRules(clips).length).toBeGreaterThan(8);
  for (const r of stageRules(cap)) expect(clips, r!).toContain(r!);
  expect(read("clips/app/app.ts")).toMatch(/attachSeek\(\$<HTMLInputElement>\("seek"\), \$\("seekbar"\), reel\)/);
});

test("one word for where it runs: device", () => {
  // The principal, 2026-09-18: "nothing leaves computer ... include phone or maybe just say device? there are multiple instances".
  const hits: string[] = [];
  for (const p of pages()) { const raw = read(p); for (const m of raw.matchAll(/(leaves?|stays? on|on) your (phone|computer|laptop)\b/gi)) hits.push(`${p}: ${m[0]}`); if (/on-phone|on-desk/.test(raw)) hits.push(`${p}: phone/computer switch`); }
  expect(hits).toEqual([]);
});

test("every tool page says Free in the header and carries the one support line; nothing asks for a key or nags", () => {
  // A, 2026-10-17: free tools, one optional support payment, a quiet link and not a popup.
  const toolPages = [...Object.values(SITES).flatMap((s) => every(s).map((f) => `${s.dist}/${f}`)), "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
  for (const p of toolPages) {
    const html = read(p);
    expect(html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0], `${p}: "Free" in the header, pointing at the support line`).toContain(FREE_TAG);
    expect(html, `${p}: the support line, byte for byte`).toContain(SUPPORT_LINE);
  }
  const studio = read(STUDIO);
  expect(studio, "the studio's support line").toMatch(new RegExp(`<p class="support" id="support">[^<]*<a href="${SUPPORT.replace(/[.?]/g, "\\$&")}" target="_blank" rel="noopener">support Småverk</a>\\.</p>`));
  for (const p of [...toolPages, STUDIO, ...LEGAL]) {
    const html = read(p);
    // One link to Polar per page, the support link: no checkout of a product, no portal, no key box, no paid panel, no pop-up.
    expect([...html.matchAll(/https:\/\/[a-z.-]*polar\.sh[^"'\s<]*/g)].map((m) => m[0]), `${p}: the only Polar link is the support link`).toEqual(LEGAL.includes(p) ? [] : [SUPPORT]);
    expect(html.match(/\bid="(price|buy|rbuy|rmark|keyrow|keystatus|keylostline|paidpanel|paidkey|afterpay|pricefine|founding)"/g) ?? [], `${p}: a price or key element`).toEqual([]);
    expect(html, `${p}: no dialog`).not.toMatch(/<dialog\b|role="dialog"/);
  }
  // No script carries a key check, a checkout or a support prompt: the link is markup and nothing opens it for the visitor.
  for (const f of ["captions/app/app.ts", "vertical/app/app.ts", "clipfinder/app/app.ts", "clips/app/app.ts", "operator/app/app.ts"].filter((f) => existsSync(join(ROOT, f)))) {
    const src = code(read(f));
    for (const bad of ["polar.sh", "/entitlements", "src/lib/unlock", "setLicensed", "licensed", "checkout_id", "support"]) expect(src, `${f}: ${bad}`).not.toContain(bad);
  }
  for (const t of ["captions", "vertical", "clipfinder", "clips"]) expect(existsSync(join(ROOT, `${t}/app/src/lib/unlock.ts`)), `${t}: the unlock module is gone`).toBe(false);
});

// Independent design review r10 and cold-user round (2026-10-17): the free change's loose ends, each held here.
test("no page says Free twice in a row, and the free wording keeps the limit apart from the price", () => {
  const toolPages = [...Object.values(SITES).flatMap((s) => every(s).map((f) => `${s.dist}/${f}`)), "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
  for (const p of toolPages) {
    const html = read(p), at = html.indexOf(SUPPORT_LINE);
    const before = text(html.slice(html.lastIndexOf("<p", at - 1), at)).trim();
    expect(before, `${p}: the line before the support line ends "Free."`).not.toMatch(/\bFree\.$/);
  }
  // "Free for clips up to five minutes" read as "longer clips cost money" (cold user, minor 1); "every export" hinted at a gated past (minor 2).
  for (const p of [...toolPages, STUDIO, ...Object.values(SITES).map((s) => `${s.dist}/llms.txt`)]) {
    const t = read(p);
    expect(t, `${p}: a limit worded as a condition of the price`).not.toMatch(/[Ff]ree (for|up to) (clips|recordings|five|four)/);
    expect(t, `${p}: "every export"`).not.toMatch(/and every export|with every export/);
  }
  // "No mark" is said once on the studio, in its tile, not on every card.
  expect([...read(STUDIO).matchAll(/<p class="price">[^<]*no mark/gi)].length, "studio cards repeating no mark").toBe(0);
  expect(read(LEGAL[0]!).match(/<meta name="description" content="([^"]*)"/)?.[1], "privacy description names every tool").toMatch(/Captions, Vertical, Clip finder, Clips (or|and) Operator/);
  expect(read(STUDIO), "og:title and twitter:title without an em dash").not.toMatch(/<meta (property|name)="(og|twitter):title" content="[^"]*—/);
});

test("one footer on every tool, every link at least 44 px wide, and the support line clear of the top edge", () => {
  const toolPages = [...Object.values(SITES).flatMap((s) => every(s).map((f) => `${s.dist}/${f}`)), "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
  for (const p of toolPages) {
    const html = read(p);
    const foot = [...(html.match(/<p class="foot">([\s\S]*?)<\/p>/)?.[1] ?? "").matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]!);
    expect(foot.slice(0, 5), `${p}: the footer's first five links`).toEqual(["hello@smaverk.com", "video.smaverk.com", "Privacy", "Terms", "For automations and agents"]);
    for (const credit of foot.slice(5)) expect(credit, `${p}: after the five, only sample credits`).toMatch(/^(Sample|Court)[^:]*: .+/);
    expect(html, `${p}: footer links 44 px wide`).toContain(".foot a{color:var(--muted);display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px}");
    expect(html, `${p}: the support line lands clear of the top edge`).toContain("#support{scroll-margin-top:24px}");
    expect(html, `${p}: a stable scrollbar gutter, so the header does not shift between pages`).toContain("html{-webkit-text-size-adjust:100%;scrollbar-gutter:stable}");
  }
  const studio = read(STUDIO);
  expect(studio, "studio footer links 44 px wide").toContain("footer a{justify-content:center;min-width:44px}");
  expect(studio, "the studio line, quiet like the tools'").toContain(".support{margin:20px 0 0;font-size:15px;color:var(--muted);text-wrap:pretty;scroll-margin-top:24px}.support a{color:inherit;");
  expect(text(studio.match(/<p class="support" id="support">[\s\S]*?<\/p>/)![0]).replace(/\s+/g, " ").replace(/ \./g, ".").trim()).toBe("If a tool helped you, you can support Småverk.");
});

test("each page says it in one line: AI, on your device", () => {
  // The principal, 2026-09-18: say "AI" and say where it runs, once, in plain words; no names of what is inside.
  for (const [name, s] of Object.entries(SITES)) {
    const html = read(`${s.dist}/${s.page}`);
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1], `${name} title`).toMatch(/\bAI\b.*on your device/);
    expect(html.match(/<p class="sub">([^<]*)<\/p>/)?.[1], `${name} line under the headline`).toMatch(/^AI [^.]*on your device\./);
    expect(html.match(/<meta name="description" content="([^"]*)"/)?.[1], `${name} description`).toMatch(/\bAI\b.*on your device/);
    expect(read(`${s.dist}/llms.txt`), `${name} llms.txt`).toMatch(/^> AI /m);
    // A search page carries its own title and description (it answers a different question), but the line under the
    // headline says the same thing in the same words on every page of the tool.
    for (const f of search(s)) expect(read(`${s.dist}/${f}`).match(/<p class="sub">([^<]*)<\/p>/)?.[1], `${f} line under the headline`).toMatch(/^AI [^.]*on your device\./);
  }
  const studio = read(STUDIO);
  expect(text(studio.match(/<h1>[\s\S]*?<\/h1>/)![0]).replace(/\s+/g, " ").trim()).toBe("Short videos for your socials, made on your device."); // studio cold user 4: say what they are for
  expect(studio.match(/<title>([^<]*)<\/title>/)?.[1]).toMatch(/AI tools that run on your device/);
});

test("the line under the main button is written once, in the page, and states the tool's limit", () => {
  // 2026-09-19: the page said "Free up to 60 seconds…" and the script, after a key was removed, wrote a different sentence.
  // With no key there is one state, so the page holds the sentence and no script writes another.
  for (const [name, s] of Object.entries(SITES)) {
    const inPage = read(`${s.dist}/${s.page}`).match(/<p class="trust" id="trust">([^<]*)<\/p>/)?.[1];
    expect(inPage, `${name}: trust line`).toBeTruthy();
    expect(inPage!, `${name}: the trust line names no price or paid version`).not.toMatch(/\$\d|paid|Free up to/i);
    expect(code(read(s.copy)), `${name}: no script writes the trust line`).not.toMatch(/(\$\("trust"\)|\btrust)\.textContent\s*=/);
  }
  expect(read(SITES.captions.dist + "/index.html")).toContain('<p class="trust" id="trust">Clips up to five minutes.');
  expect(read(SITES.vertical.dist + "/index.html")).toContain('<p class="trust" id="trust">Clips up to five minutes.');
  expect(read(SITES.clipfinder.dist + "/index.html")).toContain('<p class="trust" id="trust">Recordings up to four hours.');
});

test("every sample clip is credited where it is shown, with the source its SOURCES.md names", () => {
  // The samples are other people's Creative Commons clips: the licence asks for a credit wherever the clip plays (the tool's page and the studio card).
  const studio = read(STUDIO);
  for (const [name, app] of [["captions", "captions/app"], ["vertical", "vertical/app"]] as const) {
    const url = read(`${app}/SOURCES.md`).match(/https:\/\/www\.youtube\.com\/watch\?v=[\w-]+/)?.[0];
    expect(url, `${name}: SOURCES.md names the clip`).toBeTruthy();
    for (const [where, html] of [[`${name} page`, read(`${app}/dist/index.html`)], ["studio page", studio]] as const)
      expect(html, `${where} credits ${url}`).toMatch(new RegExp(`<a href="${url!.replace(/[?.]/g, "\\$&")}" rel="noopener">[^<]*CC BY</a>`));
  }
});

test("every studio card shows its tool at work, from the tool's own sample", () => {
  // 2026-09-23: the Clip finder card was the one card of three with no demo. Each card now plays its tool's own sample in the
  // same 16:9 slot — muted, looping, tap to stop — and every file it names exists where build.sh copies it from.
  const studio = read(STUDIO);
  const cards = [...studio.matchAll(/<div class="demo" data-demo="([a-z]+)">([\s\S]*?)<\/div>/g)].map((m) => [m[1]!, m[2]!] as const);
  expect(cards.map(([n]) => n), "a card without a demo, or a demo without a card").toEqual(["captions", "vertical", "clipfinder", "clips", "operator"]);
  expect(studio, "no card is left without a demo").not.toContain("tool nodemo");
  // Each drawn card names its own branch: a new card (Operator, a plain video) fell into the Vertical branch, which asks its
  // missing canvas for a context, threw on every load and left the card unplayable (cold user, round 7).
  for (const n of ["captions", "clipfinder", "vertical"]) expect(studio, `the ${n} card's drawing is its own branch`).toContain(`box.dataset.demo === "${n}"`);
  for (const m of studio.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1]!), "the studio's script parses").not.toThrow();
  for (const [name, html] of cards) {
    const video = html.match(/<video[^>]*>/)?.[0];
    expect(video, `${name}: the card plays the tool at work`).toBeTruthy();
    for (const a of ["muted", "loop", "playsinline", "poster="]) expect(video, `${name}: ${a}`).toContain(a);
    expect(html, `${name}: a visitor can stop it`).toContain('<button class="dtap"');
    expect(video, `${name}: the video says what is in it`).toMatch(/aria-label="[^"]{40,}"/);
  }
  // The Clip finder card is cut from the tool's own sample at build time; the build fails if the source is missing.
  expect(read("captions/app/build.sh"), "the card is made from the Clip finder's own sample").toMatch(/clipfinder\/app\/dist\/sample\.mp4[\s\S]*clipfinder-sample\.mp4/);
  expect(read("captions/app/build.sh")).toMatch(/for f in [^;]*clipfinder-sample\.mp4[^;]*clipfinder-poster\.jpg/);
  // Its sample is credited like the other two.
  expect(studio, "the studio credits the Clip finder's sample").toMatch(/Clip finder and Clips samples: NASA, public domain/);
});

test("Captions: the defaults keep the words off the speaker's face and the main button on the first screen", () => {
  // Design review 2, 2026-09-19: Big sat at the middle of the frame, over the speaker's mouth (band 0.44 to 0.55 of the height, face 0.19 to 0.47);
  // on a 1440 x 900 screen the stage took 78% of the height and the button sat below the fold (Qa.ts now fails on that too).
  const app = read("captions/app/src/draw.ts"); const at = app.match(/st === "big" \? ([\d.]+) : st === "bar" \? ([\d.]+) : ([\d.]+)/)!;
  for (const y of at.slice(1).map(Number)) { expect(y).toBeGreaterThanOrEqual(0.68); expect(y).toBeLessThanOrEqual(0.8); } // under a face, above the bottom fifth the apps cover
  const sv = [...read("captions/app/dist/index.html").matchAll(/calc\((\d+)svh \* var\(--ar/g)].map((m) => Number(m[1])); expect(sv.length).toBe(3); for (const v of sv) expect(v).toBeLessThanOrEqual(56);
  // A short screen (375x667) takes the stage down to 50svh, so the main button stays on the first screen (independent design review r10, B2).
  expect(read("captions/app/dist/index.html")).toContain("@media(max-height:700px){.demo{--sw:min(100%,calc(50svh * var(--ar,0.5625)))}}");
  for (const t of ["clipfinder", "clips"]) expect(read(`${t}/app/dist/index.html`), `${t}: the tool first on a short phone`).toContain('@media(max-width:899px) and (max-height:700px){.grid{grid-template-areas:"demo" "say" "rest"}.say{grid-area:say}.demo{grid-area:demo}.rest{grid-area:rest}}');
});

test("every host has a sitemap of its own pages, and its robots.txt points at it", () => {
  // 2026-09-19: vertical.smaverk.com/sitemap.xml answered with the page itself (no such file) and its robots.txt named another host's sitemap.
  const want: Record<string, { dist: string; file: string; hosts: string[] }> = {
    "vertical.smaverk.com": { dist: "vertical/app/dist", file: "sitemap.xml", hosts: ["vertical.smaverk.com"] },
    "captions.smaverk.com": { dist: "captions/app/dist", file: "sitemap.xml", hosts: ["captions.smaverk.com", "smaverk.com", "video.smaverk.com"] }, // one deployment answers on all three hosts
    "smaverk.com": { dist: "captions/app/dist", file: "studio-sitemap.xml", hosts: ["captions.smaverk.com", "smaverk.com", "video.smaverk.com"] },
    "video.smaverk.com": { dist: "captions/app/dist", file: "video-sitemap.xml", hosts: ["captions.smaverk.com", "smaverk.com", "video.smaverk.com"] },
    "clipfinder.smaverk.com": { dist: "clipfinder/app/dist", file: "sitemap.xml", hosts: ["clipfinder.smaverk.com"] },
    "clips.smaverk.com": { dist: "clips/app/dist", file: "sitemap.xml", hosts: ["clips.smaverk.com"] },
  };
  for (const [host, w] of Object.entries(want)) {
    const xml = read(`${w.dist}/${w.file}`); const locs = [...xml.matchAll(/<loc>https:\/\/([^/<]+)(\/[^<]*)<\/loc>/g)]; expect(locs.length, `${host}: sitemap lists pages`).toBeGreaterThan(0);
    for (const m of locs) expect(`${host}: ${m[1]}`).toBe(`${host}: ${host}`);
    const robots = read(`${w.dist}/robots.txt`); expect(robots, `${host}: robots.txt names its sitemap`).toContain(`Sitemap: https://${host}/sitemap.xml`);
    for (const m of robots.matchAll(/^Sitemap: https:\/\/([^/\s]+)\//gm)) expect(w.hosts, `${w.dist}/robots.txt names a sitemap on a host it serves`).toContain(m[1]!);
  }
});

test("search engines can verify and be told about every host", () => {
  // The principal, 2026-09-19: "isnt seo stuff done before?" It was done for Captions on day one and not carried to Vertical and the studio page.
  // Every page a host serves at "/" carries the Search Console tag; every deployment carries the IndexNow key file that `_tools/indexnow.ts` uses.
  for (const p of ["captions/app/dist/index.html", "captions/app/dist/studio.html", "captions/app/dist/home.html", "vertical/app/dist/index.html", "clipfinder/app/dist/index.html", "clips/app/dist/index.html"]) { const h = read(p); expect(h, `${p}: Search Console tag`).toMatch(/<meta name="google-site-verification" content="[\w-]{20,}">/); expect(h, `${p}: canonical`).toMatch(/<link rel="canonical" href="https:\/\/[a-z.]*smaverk\.com\/">/); expect(h, `${p}: description`).toMatch(/<meta name="description" content="[^"]{60,}">/); }
  for (const d of ["captions/app/dist", "vertical/app/dist", "clipfinder/app/dist", "clips/app/dist"]) { const key = readdirSync(join(ROOT, d)).find((f) => /^[0-9a-f]{32}\.txt$/.test(f)); expect(key, `${d}: IndexNow key file`).toBeTruthy(); expect(read(`${d}/${key}`).trim()).toBe(key!.slice(0, 32)); }
});

test("every page stays inside the word budget at rest", () => {
  // The principal, 2026-09-18: "so many words". Qa.ts fails a live page over 240; every page here holds itself to 235.
  // A closed answer costs nothing, which is why the three questions on a search page are in <details>.
  // This counts what the markup says. A browser counts a little more on Vertical, whose progress box is already on the
  // screen at rest (about 15 words; the live audit of the home page read 232 where this reads 216), so a Vertical page
  // is written with that much room to spare — tests/smoke.mjs reads the real number in Chromium and fails over 240.
  const over: string[] = [];
  for (const s of Object.values(SITES)) for (const f of every(s)) { const n = wordsAtRest(read(`${s.dist}/${f}`)); if (n > 235) over.push(`${s.dist}/${f}: ${n} words`); }
  expect(over).toEqual([]);
});

test("each search page is its own page: address, title, description, one headline, three sourced answers, ways on", () => {
  // Google's spam policies (28 Aug 2026) call substantially similar pages built for similar queries a doorway. Each page
  // here answers a different person's question, opens the tool in its own state and carries facts no sibling carries,
  // each with the source it came from. This test holds that shape; the words themselves are the writer's job.
  for (const s of Object.values(SITES)) for (const f of search(s)) {
    const html = read(`${s.dist}/${f}`); const slug = f.replace(/\.html$/, ""); const where = `${s.dist}/${f}`;
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1], `${where}: canonical`).toBe(`https://${s.host}/${slug}`);
    expect(html.match(/<meta property="og:url" content="([^"]+)"/)?.[1], `${where}: og:url`).toBe(`https://${s.host}/${slug}`);
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title.length, `${where}: title "${title}" is ${title.length} characters`).toBeLessThanOrEqual(60);
    const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    expect(desc.length, `${where}: description is ${desc.length} characters`).toBeLessThanOrEqual(155);
    expect(desc.length, `${where}: description is written`).toBeGreaterThanOrEqual(60);
    expect(html.match(/<h1>/g)?.length, `${where}: exactly one headline`).toBe(1);
    expect(html, `${where}: no FAQPage markup (the rich result ended 7 May 2026)`).not.toContain('"@type":"FAQPage"');
    expect(html, `${where}: a breadcrumb, which still shows`).toContain('"@type":"BreadcrumbList"');
    expect(html, `${where}: no rating we do not have`).not.toContain("aggregateRating");
    expect(html, `${where}: Free in the header`).toContain(FREE_TAG);
    expect(html, `${where}: the support line`).toContain(SUPPORT_LINE);
    const details = [...html.matchAll(/<details><summary>([^<]*)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)];
    expect(details.length, `${where}: three questions`).toBe(3);
    for (const d of details) {
      expect(d[0], `${where}: "${d[1]}" is closed at rest`).not.toContain("<details open");
      expect(d[2], `${where}: "${d[1]}" ends in where the answer comes from`).toMatch(/<a href="https:\/\/[^"]+" rel="noopener">[^<]+<\/a>\s*$/);
    }
    const more = html.slice(html.indexOf("<h2>More ways to use it</h2>"));
    const links = [...more.matchAll(/<li><a href="([^"]+)">/g)].map((m) => m[1]!);
    expect(links.length, `${where}: ways on from here`).toBeGreaterThanOrEqual(2);
    for (const href of links) expect(`${where} → ${href}: ${fileFor(href, s.host)}`, "a way on that lands nowhere").not.toMatch(/MISSING|: null/);
  }
  // The home pages send readers the other way, to the pages written for them.
  for (const s of Object.values(SITES)) {
    const home = read(`${s.dist}/${s.page}`);
    if (!search(s).length) continue; // a tool with no search pages yet has nowhere to send anyone
    expect(home, `${s.dist}/${s.page}: More ways to use it`).toContain("<h2>More ways to use it</h2>");
    for (const f of search(s)) expect(home, `${s.dist}/${s.page} links to /${f}`).toContain(`href="/${f.replace(/\.html$/, "")}"`);
  }
});

test("each host's sitemap, llms.txt and _headers know exactly the pages it serves", () => {
  for (const s of Object.values(SITES)) {
    const want = [`https://${s.host}/`, ...search(s).map((f) => `https://${s.host}/${f.replace(/\.html$/, "")}`)].sort();
    expect([...read(`${s.dist}/sitemap.xml`).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!).sort(), `${s.dist}/sitemap.xml`).toEqual(want);
    const headers = read(`${s.dist}/_headers`);
    for (const f of search(s)) {
      const slug = f.replace(/\.html$/, "");
      expect(read(`${s.dist}/llms.txt`), `${s.dist}/llms.txt names /${slug}`).toContain(`/${slug}`);
      expect(headers, `${s.dist}/_headers: /${slug}`).toContain(`/${slug}\n  Cache-Control: no-cache`); // html that changes with every build
    }
  }
});

test("the terms protect the studio: bounded refunds, a liability cap, no open-ended remedies", () => {
  // The principal, 2026-09-19: "this basically means that we will refund as long as there is an issue… be more protective of smaverk."
  // Since 2026-10-17 nothing is sold: a support payment is a gift that buys and unlocks nothing; a mistaken one is refunded in
  // 14 days; changes carry a best-effort fix only, liability is capped at what was paid in support, consumer rights are kept.
  const terms = text(read(LEGAL[1]!)).replace(/\s+/g, " ");
  for (const must of [/Every tool is free to use in full, with no account and no key/, /it buys nothing and unlocks nothing/, /there is no subscription/, /in the first 14 days after you paid/, /After them we do not refund, unless the law of your country gives you a right we cannot set aside/, /Polar Software, Inc\., our merchant of record/, /provided as they are/, /as far as the law allows/i, /the most we can owe you in total is what you paid us in support payments in the 12 months before the claim/, /not a promise that the tool will be offered/, /try to put it right/, /Do not share, publish, resell or rent/, /Swedish law applies/, /rights that the consumer law of your country gives you/, /By using a tool or sending a support payment you accept these terms/]) expect(terms).toMatch(must);
  expect(terms, "nothing left of the paid versions").not.toMatch(/paid version|free version|your key|a key opens|buying a key|price is on/i);
  for (const open of [/put it right or refund/i, /\bany time\b/i, /\bguarantee/i, /\blifetime\b/i, /\bunlimited\b/i, /money back whenever/i]) expect(terms).not.toMatch(open);
  // the one refund promise on the product pages is the bounded one, word for word
  for (const s of Object.values(SITES)) for (const f of readdirSync(join(ROOT, s.dist)).filter((f) => f.endsWith(".html") && !/^(google|privacy|terms)/.test(f))) { const t = text(read(`${s.dist}/${f}`)); for (const m of t.matchAll(/refund[^.]{0,60}/gi)) expect(`${f}: ${m[0].trim()}`).toMatch(/: Refund within 14 days/); }
});

// Clip finder is in SITES now, so everything above applies to it. What is left here is what is true of
// this tool and no other: a stricter list of words that would give away how it is built, a sample that is
// public-domain rather than CC BY, a dist where nothing is content-addressed, and the free-while-new rail
// with its one sleeping constant. A check that SITES already makes is not repeated.
const CF = { dist: "clipfinder/app/dist", src: ["clipfinder/app/app.ts", "clipfinder/app/worker.ts"], host: "clipfinder.smaverk.com" };
const cfPages = () => readdirSync(join(ROOT, CF.dist)).filter((f) => /\.(html|txt)$/.test(f) && !/^google/.test(f)).map((f) => `${CF.dist}/${f}`);

test("Clip finder: no permanence wording, one word for where it runs, and nothing about how it is built", () => {
  const METHOD = /\b(whisper|moonshine|webgpu|wasm|webassembly|webcodecs|hugging ?face|jsdelivr|onnx|transformers(\.js)?|tensorflow|mediabunny|ffmpeg|speech model|speech recognition|language model|neural|machine learning|texttiling|embedding|h\.?264|opus)\b/i;
  const hits: string[] = [];
  for (const p of cfPages()) {
    const t = text(read(p));
    for (const m of t.matchAll(/[^.]{0,40}\b(never|forever|ever)\b[^.]{0,30}/gi)) hits.push(`${p}: permanence — …${m[0].trim()}…`);
    for (const m of read(p).matchAll(/(leaves?|stays? on|on) your (phone|computer|laptop)\b/gi)) hits.push(`${p}: ${m[0]}`);
    for (const line of t.split(/\n|(?<=[.!?])\s/)) { const m = line.match(METHOD); if (m) hits.push(`${p}: "${m[0]}" in …${line.trim().slice(0, 80)}`); }
  }
  for (const f of CF.src) {
    for (const m of code(read(f)).matchAll(/["'`][^"'`\n]*\b(never|forever|ever)\b[^"'`\n]*["'`]/gi)) hits.push(`${f}: permanence — ${m[0].slice(0, 90)}`);
    for (const m of code(read(f)).matchAll(/["'`]([^"'`\n]* [^"'`\n]* [^"'`\n]*)["'`]/g)) { const hit = m[1]!.match(METHOD); if (hit) hits.push(`${f}: "${hit[0]}" in ${m[1]!.slice(0, 80)}`); }
  }
  expect(hits).toEqual([]);
});

test("Clip finder: it says AI, it says where it runs, and it says the same thing in every place it says it", () => {
  const html = read(`${CF.dist}/index.html`);
  expect(html.match(/<title>([^<]*)<\/title>/)?.[1], "title").toMatch(/\bAI\b.*on your device/);
  expect(html.match(/<p class="sub">([^<]*)<\/p>/)?.[1], "line under the headline").toMatch(/^AI [^.]*on your device\./);
  expect(html.match(/<meta name="description" content="([^"]*)"/)?.[1], "description").toMatch(/\bAI\b.*on your device/);
  expect(read(`${CF.dist}/llms.txt`), "llms.txt").toMatch(/^> AI /m);
  // The sentence under the main button states the one limit, and says the recording stays on the device.
  expect(html.match(/<p class="trust" id="trust">([^<]*)<\/p>/)?.[1], "trust line").toBe("Recordings up to four hours. English. Your recording stays on your device.");
});

test("Clip finder: free, four hours and every export for everyone, the same in the page, llms.txt and the script", () => {
  // $29 once from 2026-09-22; free from 2026-10-17 (A). One limit, one constant, and no export waits for a payment.
  for (const f of ["index.html", "llms.txt"]) { const t = text(read(`${CF.dist}/${f}`)); expect(t, `${f}: the limit`).toMatch(/four hours/); expect(t, `${f}: no old free limit`).not.toMatch(/30 minutes/); expect(t.replace(/\$\d+ a month/g, " ").match(/\$\d+/g) ?? [], `${f}: no price`).toEqual([]); }
  const app = read(CF.src[0]!);
  expect(app, "the limit is one constant").toMatch(/const LIMIT_S = 4 \* 3600;/);
  expect(code(app), "no free and paid limits").not.toMatch(/FREE_S|PAID_S|TRIAL|PRICE|needsPaying|mustPay/);
  expect(existsSync(join(ROOT, "clipfinder/app/src/lib/pricing.ts")), "the pricing module is gone").toBe(false);
});

test("Clip finder: it promises only what it measures", () => {
  // The whole product rests on not overclaiming: it finds moments, it does not predict what an audience does.
  const page = text(read(`${CF.dist}/index.html`));
  const both = page + read(`${CF.dist}/llms.txt`);
  const found: string[] = [];
  // Nothing anywhere may promise an audience's behaviour.
  for (const claim of [/\bviral/i, /go viral/i, /best moments/i, /will perform/i, /\bengagement\b/i, /\bguarantee/i]) { const m = both.match(claim); if (m) found.push(`page or llms.txt: "${m[0]}"`); }
  // And the page itself never shows a number standing in for a judgment. llms.txt may say what scored what
  // against random, because that is the measurement talking to a reader who asked for it.
  for (const claim of [/\bscore\b/i, /\brating\b/i, /\branked \d/i, /\b\d+ *\/ *10\b/]) { const m = page.match(claim); if (m) found.push(`page: "${m[0]}"`); }
  expect(found).toEqual([]);
  // And it says so out loud, in the page and to anything reading llms.txt.
  expect(both).toMatch(/does not (guess|predict)/i);
  expect(read(`${CF.dist}/llms.txt`)).toMatch(/It does not predict what an audience will do with a clip/);
});

test("Clip finder: only files whose names change with their content are cached as immutable", () => {
  let path = "";
  for (const l of read(`${CF.dist}/_headers`).split("\n")) {
    if (/^\S/.test(l)) path = l.trim();
    else if (/immutable/.test(l)) expect(`${CF.dist}: ${path}`).toBe(`${CF.dist}: (nothing here is content-addressed)`);
  }
});

test("Clip finder: the links, the hosts and the credit", () => {
  for (const p of cfPages()) for (const m of read(p).matchAll(/href="([^"]*\b(privacy|terms)\b[^"]*)"/g)) expect(`${p}: ${m[1]}`).toMatch(/^.*: https:\/\/smaverk\.com\/(privacy|terms)$/);
  // Nothing on the page comes from another company except the analytics beacon.
  const bad: string[] = [];
  for (const m of read(`${CF.dist}/index.html`).matchAll(/<(?:script|link|img|video|source|iframe|audio)\b[^>]*\b(?:src|href)=["'](https?:\/\/[^"']+)["'][^>]*>/g)) {
    if (/rel="canonical"|rel="alternate"/.test(m[0]!)) continue;
    if (!/^https:\/\/(static\.cloudflareinsights\.com|([a-z]+\.)?smaverk\.com)\//.test(m[1]!)) bad.push(m[1]!);
  }
  expect(bad).toEqual([]);
  // Every outside address the scripts know is one the privacy page already accounts for.
  const KNOWN = ["captions.smaverk.com", "vertical.smaverk.com", "clipfinder.smaverk.com", "smaverk.com"];
  const unknown: string[] = [];
  for (const f of CF.src) for (const m of code(read(f)).matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) if (!KNOWN.includes(m[1]!)) unknown.push(`${f}: ${m[1]}`);
  expect(unknown).toEqual([]);
  // The sample is somebody else's recording: it is credited on the page and its source is written down.
  const sources = read("clipfinder/app/SOURCES.md");
  const url = sources.match(/https:\/\/(www\.nasa\.gov|images\.nasa\.gov)\/[\w/-]+/)?.[0];
  expect(url, "SOURCES.md names where the sample came from").toBeTruthy();
  expect(read(`${CF.dist}/index.html`), "the page credits the sample").toContain(url!);
  const sample = JSON.parse(read(`${CF.dist}/sample.json`));
  expect(sample.credit, "the sample carries its credit").toBeTruthy();
  expect(sample.url, "the sample carries its source").toBe(url);
});

test("Clip finder wears the studio's clothes: every style rule Captions also has is identical", () => {
  const ALLOWED = new Set([".demo", ".chips", ".chip", ".chip canvas", ".chip span", ".result", ".caplabel", ".caplabel b", "details p", "input,textarea"]); // its own shapes: a list of moments instead of a video stage
  const rules = (file: string) => {
    const css = [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/@media[^{]+\{([\s\S]*?\})\s*\}/g, " ");
    const out = new Map<string, string>();
    for (const r of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) for (const sel of r[1]!.split(",")) out.set(sel.trim(), r[2]!.trim().replace(/;$/, ""));
    return out;
  };
  const a = rules("captions/app/dist/index.html"); const b = rules(`${CF.dist}/index.html`);
  const drift: string[] = []; let shared = 0;
  for (const [sel, body] of a) if (b.has(sel)) { shared++; if (b.get(sel) !== body && !ALLOWED.has(sel)) drift.push(sel); }
  expect(shared, "the two pages share a look").toBeGreaterThan(50);
  expect(drift).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------
// No keys (free since 2026-10-17). The unlock worker stays deployed and unused; no page talks to it or stores a key.
// ---------------------------------------------------------------------------------------------------------
test("every page tells the same story: free, no key, no account, and no device count", () => {
  for (const s of Object.values(SITES)) {
    const llms = read(`${s.dist}/llms.txt`);
    expect(llms, `${s.dist}/llms.txt: no key`).toContain("There is no key, account or paywall: everything is open to everyone.");
    expect(llms, `${s.dist}/llms.txt: no unlock call`).not.toMatch(/unlock\.smaverk\.com|smaverk\.key|#keygo/);
    expect(text(read(`${s.dist}/${s.page}`)), `${s.page}: no unlock story`).not.toMatch(/nothing to paste|paste your key|already paid/i);
  }
  // A device count nobody enforces is a promise we break. No page states one.
  for (const p of [...pages(), ...cfPages(), STUDIO, ...LEGAL]) {
    expect(text(read(p)), `${p}: an unenforced device count`).not.toMatch(/\b(one|two|three|four|five|\d+)\s+devices\b/i);
  }
  for (const p of LEGAL) for (const tool of ["Captions", "Vertical", "Clip finder", "Clips", "Operator"]) expect(read(p), `${p}: covers ${tool}`).toContain(tool);
});

// dist/studio-demo/ is GITIGNORED and made only by build.sh, and a Pages deploy uploads dist/ as ONE snapshot —
// so a build that writes one card's files and not another's DELETES the missing one from the live page. That is
// the failure where a gate certified an empty card while a different page deployed.
test("every studio card's data is produced by the build, together", () => {
  const bs = read("captions/app/build.sh");
  for (const f of ["vertical-sample.mp4", "vertical-track.json", "vertical-poster.jpg", "clipfinder-sample.json", "clips-strip.mp4", "clips-poster.jpg", "operator-sample.mp4", "operator-poster.jpg"])
    expect(bs, `build.sh produces studio-demo/${f}`).toContain(`dist/studio-demo/${f}`);
  expect(bs, "build.sh refuses to finish with a card's data missing").toMatch(/is missing or empty; deploying now would take it off the live page/);
  // The clip finder's card data has to be able to draw, not merely exist: the card is a rail with moments on it.
  // A poster is a frame of the video it stands for, so the two share a shape (studio design review, four cards, B1: the
  // Clips card showed one portrait clip, then played three side by side). By construction in build.sh, and measured after a build.
  expect(bs, "the Clips card's poster is cut from its strip").toMatch(/-i \.\.\/\.\.\/clips\/app\/dist\/sample-strip\.mp4 -frames:v 1[^\n]*dist\/studio-demo\/clips-poster\.jpg/);
  const shape = (p: string) => { const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(ROOT, p)]).toString().trim().split(",").map(Number); return w! / h!; };
  for (const [poster, video] of [["vertical-poster.jpg", "vertical-sample.mp4"], ["clipfinder-poster.jpg", "clipfinder-sample.mp4"], ["clips-poster.jpg", "clips-strip.mp4"]]) {
    const d = "captions/app/dist/studio-demo/";
    if (existsSync(join(ROOT, d + poster)) && existsSync(join(ROOT, d + video))) expect(Math.abs(shape(d + poster) / shape(d + video) - 1), `${poster} has the shape of ${video}`).toBeLessThan(0.01);
  }
  const f = "captions/app/dist/studio-demo/clipfinder-sample.json";
  if (existsSync(join(ROOT, f))) {
    const s = JSON.parse(read(f));
    expect(s.durationS, "the rail needs a length to draw against").toBeGreaterThan(60);
    const found = (s.sets && (s.sets["60"] ?? Object.values(s.sets)[0])) as any[];
    expect(found?.length, "the rail needs more than one moment lit on it").toBeGreaterThan(1);
    expect(found.every((m: any) => m.endS > m.startS), "every moment needs a length").toBe(true);
  }
});

// Terms says what each tool does for everyone, and names no price.
test("terms describes what every tool does for free, and names no price", () => {
  const terms = text(read(LEGAL[1]!)).replace(/\s+/g, " ");
  expect(terms).toMatch(/In Clip finder a recording can be up to four hours, and every export saves/);
  expect(terms).toMatch(/In Captions and Vertical a clip can be up to five minutes/);
  expect(terms, "no price in the terms").not.toMatch(/\$\d+/);
  expect(terms, "nothing left from the free-while-new days").not.toMatch(/while it is new/i);
});

// The studio page exists to list the tools. A live tool missing from it is the failure this guards.
test("the studio lists every tool that is live, each one free", () => {
  const studio = read(STUDIO); const t = text(studio).replace(/\s+/g, " ");
  for (const [name, host] of [["Captions", "captions"], ["Vertical", "vertical"], ["Clip finder", "clipfinder"], ["Clips", "clips"], ["Operator", "operator"]] as const) {
    expect(t, `the studio names ${name}`).toContain(name);
    expect(studio, `${name} links to its own host`).toContain(`https://${host}.smaverk.com/?src=studio`);
  }
  expect((studio.match(/<article class="tool/g) ?? []).length, "one card per tool").toBe(5);
  // Every card says it is free, in words, and states its tool's limit.
  const lines = [...studio.matchAll(/<p class="price">([^<]*)<\/p>/g)].map((m) => m[1]!);
  expect(lines, "one line per card, each starting Free").toEqual(["Free. It captions the first five minutes of a clip.", "Free. It works on the first five minutes of a clip.", "Free. It reads up to four hours of a recording.", "Free. Every clip saved.", "Free."]);
  expect(t, "nothing left from the paid or preview days").not.toMatch(/while it is (new|a preview)|pay once|\bonce:/i);
  expect(text(studio.match(/<p class="sub">[\s\S]*?<\/p>/)![0]).trim()).toBe("Five free tools, one job each.");
  // The true claim for a tool that reads recordings, not the absolute.
  expect(t, "the clip finder's claim is about the recording").toContain("Your recording stays on your device");
  // Anything a machine reads must know about it too.
  expect(read(`${SITES.captions.dist}/llms.txt`), "llms.txt names the clip finder").toContain("clipfinder.smaverk.com");
  // A limit the tool page states belongs on the card that sends people there. The cold-user round (2026-09-21) found
  // the clip finder card silent about English while its own page says so twice — a Swedish podcaster, which is who
  // "Småverk, Sweden" recruits, would spend a quarter of an hour of his laptop on a 1h40m file before finding out.
  for (const card of studio.split("<article").slice(1)) {
    const name = card.match(/<h3>([^<]+)<\/h3>/)?.[1]; if (!name) continue;
    const app = ({ Captions: "captions", "Clip finder": "clipfinder", Clips: "clips" } as Record<string, string>)[name]; if (!app) continue;
    if (!text(read(`${app}/app/dist/index.html`)).match(/\bEnglish\b/)) continue;
    expect(text(card), `the ${name} card carries the English limit its tool page states`).toMatch(/\bEnglish\b/);
  }
});

// A, 27 Oct 2026, after the first Maindesk studio: "the page looks super busy, I am thinking video tools should go on their
// own subdomain and the smaverk should be mostly about the computers or cloud for your agent and some demo there". So
// smaverk.com (home.html) is Maindesk's short page with the app itself as its demo, and video.smaverk.com (studio.html)
// is the video tools' page as it was. Every tool, llms.txt, sitemap and legal page says where each one lives.
const HOST_MW = "captions/app/functions/_middleware.js";
test("smaverk.com leads with Maindesk: what it does, its demo, one tagged link, no price, and a way to the video tools", () => {
  const home = read(HOME), t = text(home.slice(home.indexOf("<body"))).replace(/\s+/g, " ");
  expect(home.match(/<p class="kicker">([^<]*)<\/p>\s*<h1>/)?.[1], "Maindesk named above the headline").toBe("Maindesk");
  expect(text(home.match(/<h1>[\s\S]*?<\/h1>/)![0]).replace(/\s+/g, " ").replace(/ ([,.])/g, "$1").trim()).toBe("Computers for your AI agent.");
  for (const f of [/Linux, Windows and a Mac in the cloud/, /keeps working/, /from your phone/]) expect(t, String(f)).toMatch(f);
  expect(wordsAtRest(home), "well under the 240-word budget").toBeLessThanOrEqual(80);
  const links = [...home.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1]!, m[2]!.trim()]);
  expect(links.filter(([h]) => /maindesk\.smaverk\.com/.test(h)), "one Maindesk link, tagged").toEqual([["https://maindesk.smaverk.com/?src=smaverk", "Open Maindesk"]]);
  expect(links, "the video tools, one tap away").toContainEqual(["https://video.smaverk.com/?src=smaverk", "Free video tools →"]);
  expect(home.indexOf("Open Maindesk"), "Maindesk before the video tools").toBeLessThan(home.indexOf("Free video tools"));
  for (const need of ["Småverk, Sweden", "hello@smaverk.com", "Privacy", "Terms"]) expect(text(home.match(/<footer>[\s\S]*?<\/footer>/)![0]), `footer: ${need}`).toContain(need);
  // No price, and "free" only in the link to the video tools.
  expect(t.replace("Free video tools", ""), "a price or free wording on smaverk.com").not.toMatch(/\$|€|£|\bUSD\b|\bSEK\b|\bkr\b|a month|per month|\bfree\b|\btrial\b/i);
  expect(home, "no tool cards here").not.toMatch(/<article class="tool|data-demo=/);
  // The demo is the app itself (design review r10, B1): image files of real screens, desk and phone in each theme, small,
  // named for a screen reader, with an edge in light mode (r10b R1); the pair on screen is eager and the other is warmed
  // after load (R3, R4); no drawing.
  const app = home.match(/<div class="app" id="app" role="img" aria-label="[^"]{40,}">([\s\S]*?)<\/div>\s*<script>/)?.[1] ?? "";
  expect(app, "the demo").toBeTruthy();
  expect(app, "no drawing").not.toMatch(/<svg\b|<canvas\b/);
  const files = [...app.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]!);
  expect([...new Set(files)].sort()).toEqual(["maindesk/app-desktop-dark.webp", "maindesk/app-desktop-light.webp", "maindesk/app-phone-dark.webp", "maindesk/app-phone-light.webp"]);
  for (const f of new Set(files)) expect(statSync(join(ROOT, "captions/app/dist", f)).size, `${f} under 80 KB`).toBeLessThan(80e3);
  expect(home).toContain(".app::after{content:\"\";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--line);pointer-events:none}");
  expect(home).toContain(":root[data-theme=dark] .app .lt{display:none}");
  // r11 H1: on a phone the frame starts at "Needs you", so the demo shows the agent's question and the running tasks, not an empty form.
  expect(home).toContain("@media(max-width:719px){.app{aspect-ratio:10/9}.app .main{margin-top:-92%}}");
  // r11 H3: the share image is a JPG every link preview shows, 1200 x 630, made from the real stills; H4: Terms never wraps alone.
  expect(home).toMatch(/<meta property="og:image" content="https:\/\/smaverk\.com\/maindesk\/og\.jpg\?v=\d+"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">/);
  expect(statSync(join(ROOT, "captions/app/dist/maindesk/og.jpg")).size, "og.jpg under 200 KB").toBeLessThan(200e3);
  expect(home).toContain('<span class="pair"><a href="https://smaverk.com/privacy">Privacy</a><a href="https://smaverk.com/terms">Terms</a></span>');
  expect(home, "the pair on screen loads first").toMatch(/i\.loading="eager";i\.fetchPriority="high"/);
  expect(home, "the other pair is warmed after load").toMatch(/addEventListener\("load",function\(\)\{setTimeout\(/);
  // Everything that says what this page is names Maindesk.
  const meta = (p: string) => home.match(new RegExp(`<meta (?:name|property)="${p}" content="([^"]*)"`))?.[1] ?? "";
  const ld = JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!).description as string;
  for (const [where, v] of [["title", home.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""], ["description", meta("description")], ["og:title", meta("og:title")], ["og:description", meta("og:description")], ["twitter:description", meta("twitter:description")], ["JSON-LD", ld]] as const)
    expect(v, `${where} names Maindesk`).toMatch(/Maindesk/);
  expect(ld, "JSON-LD points at the video tools").toContain("https://video.smaverk.com");
  expect(home).toContain('<link rel="canonical" href="https://smaverk.com/">');
  const lastmod = read("captions/app/dist/studio-sitemap.xml").match(/<loc>https:\/\/smaverk\.com\/<\/loc><lastmod>([\d-]+)</)?.[1] ?? "";
  expect(lastmod >= "2026-10-27", `smaverk.com's sitemap dates the change (lastmod ${lastmod})`).toBe(true);
});

test("video.smaverk.com is the video tools' page: the five tools, no Maindesk section, no price, and a line back to Småverk", () => {
  const studio = read(STUDIO);
  expect(studio).toContain('<link rel="canonical" href="https://video.smaverk.com/">');
  expect(studio).toContain('<meta property="og:url" content="https://video.smaverk.com/">');
  expect(studio, "no Maindesk section on the tools' page").not.toMatch(/class="md"|class="shot"|maindesk\//);
  expect(studio, "one quiet line back to Småverk").toContain('<a href="https://smaverk.com/?src=video">From Småverk, which also makes Maindesk</a>');
  expect(wordsAtRest(studio), "inside the word budget").toBeLessThanOrEqual(225);
  expect(read("captions/app/dist/video-sitemap.xml")).toContain("<loc>https://video.smaverk.com/</loc>");
});

test("each host gets its own page, and the studio's old address sends visitors to the video tools", () => {
  const mw = read(HOST_MW), routes = JSON.parse(read("captions/app/dist/_routes.json")).include as string[];
  for (const p of ["/", "/sitemap.xml", "/studio", "/studio.html", "/home", "/home.html"]) expect(routes, `_routes.json runs the function on ${p}`).toContain(p);
  expect(mw).toContain('const STUDIO_HOSTS = new Set(["smaverk.com", "www.smaverk.com"]);');
  expect(mw).toContain('const VIDEO_HOSTS = new Set(["video.smaverk.com"]);');
  expect(mw).toContain('if (url.pathname === "/") return page(env, request, url, "/home");');
  expect(mw).toContain('if (url.pathname === "/") return page(env, request, url, "/studio");');
  expect(mw).toContain('if (url.pathname === "/sitemap.xml") return page(env, request, url, "/video-sitemap.xml");');
  expect(mw).toMatch(/url\.pathname === "\/studio" \|\| url\.pathname === "\/studio\.html"\) return Response\.redirect\(`https:\/\/video\.smaverk\.com\/\$\{url\.search\}`, 301\)/);
  // An old link to the studio's support line (smaverk.com/#support) lands on the video tools' support line.
  expect(read(HOME)).toContain('if(location.hash==="#support")location.replace("https://video.smaverk.com/#support")');
  if (existsSync(join(ROOT, "events/src/index.ts"))) // the count worker is not in the public mirror
    expect(read("events/src/index.ts"), "the count worker accepts video.smaverk.com").toMatch(/const TOOLS = new Set\(\[[^\]]*"video"/);
});

test("the tools point at video.smaverk.com: the brand, the footer, every llms.txt; the legal pages say where each product lives", () => {
  const toolPages = [...Object.values(SITES).flatMap((s) => every(s).map((f) => `${s.dist}/${f}`)), "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
  for (const p of [...toolPages, STUDIO]) expect(read(p), `${p}: the brand opens the video tools' page`).toContain('<a class="brand" href="https://video.smaverk.com"><i></i>Småverk');
  for (const p of toolPages) expect(read(p), `${p}: the footer's page link`).toContain('<a href="https://video.smaverk.com">video.smaverk.com</a>');
  for (const p of [HOME, ...LEGAL]) expect(read(p), `${p}: the brand opens smaverk.com`).toContain('<a class="brand" href="https://smaverk.com"><i></i>Småverk');
  // Every tool's llms.txt (Captions' is also smaverk.com/llms.txt) names the tools' page and says the same one sentence about Maindesk.
  const MD_LINE = "Småverk also runs Maindesk (https://maindesk.smaverk.com), a separate service where a person's AI agent gets its own computers in the cloud (Linux, Windows and a Mac), with plans and terms of its own.";
  for (const f of [...Object.values(SITES).map((s) => `${s.dist}/llms.txt`), "operator/app/dist/llms.txt"].filter((f) => existsSync(join(ROOT, f)))) {
    const l = read(f);
    expect(l, `${f} names Maindesk`).toContain(MD_LINE);
    expect(l, `${f}: the tools' page`).toMatch(/https:\/\/video\.smaverk\.com (is the page listing every tool|lists every tool|lists them all)/);
    expect(l, `${f}: no tool list on smaverk.com`).not.toMatch(/https:\/\/smaverk\.com (is the studio page|lists)/);
  }
  for (const l of LEGAL) {
    const h = read(l);
    expect(h).toContain('For every Småverk video tool at <a href="https://video.smaverk.com">video.smaverk.com</a>');
    expect(h).toContain('Maindesk, our service for AI agents at <a href="https://smaverk.com">smaverk.com</a>');
  }
  expect(read(LEGAL[0]!)).toContain('<a href="https://maindesk.smaverk.com/privacy">');
  expect(read(LEGAL[1]!)).toContain('<a href="https://maindesk.smaverk.com/terms">');
  expect(text(read(LEGAL[0]!)), "privacy: the only money we take").not.toMatch(/the only money we take/);
});

// ---------------------------------------------------------------------------------------------------------
// Operator (live at operator.smaverk.com as a free preview, no price yet). It is not in SITES because SITES requires a price
// and a public host. Until it has both, it is held to the rules that do not depend on them.
// ---------------------------------------------------------------------------------------------------------
// The public mirror carries the Operator's demo but not its code, so these run where the code is (here; its deploy runs them).
const opTest = existsSync(join(ROOT, "operator/app/app.ts")) ? test : test.skip;
const OP = { dist: "operator/app/dist", src: ["operator/app/app.ts", "operator/app/src/detect.ts", "operator/app/src/record.ts", "operator/app/src/embed.ts", "operator/app/src/embed-worker.ts", "operator/app/src/people.ts", "operator/app/src/vision-worker.ts", "operator/app/src/mouths.ts", "operator/app/src/talk-render.ts"] };

opTest("Operator wears the studio's clothes: every style rule Vertical also has is identical", () => {
  const rules = (file: string) => { const css = [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/@media[^{]+\{([\s\S]*?\})\s*\}/g, " "); const out = new Map<string, string>(); for (const r of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) for (const sel of r[1]!.split(",")) out.set(sel.trim(), r[2]!.trim().replace(/;$/, "")); return out; };
  const a = rules("vertical/app/dist/index.html"), b = rules(`${OP.dist}/index.html`); const drift: string[] = []; let shared = 0;
  for (const [sel, body] of a) if (b.has(sel)) { shared++; if (b.get(sel) !== body) drift.push(sel); }
  expect(shared, "the two pages share a look").toBeGreaterThan(80); expect(drift).toEqual([]);
});

opTest("Operator: plain words at rest, one word for where it runs, no permanence wording, nothing about how it is built", () => {
  const html = read(`${OP.dist}/index.html`); const t = text(html);
  expect(wordsAtRest(html)).toBeLessThanOrEqual(240);
  expect(t.match(/[^.]{0,40}\b(never|forever|ever)\b[^.]{0,30}/gi) ?? []).toEqual([]);
  for (const f of OP.src) expect(code(read(f)).match(/["'`][^"'`\n]*\b(never|forever|ever)\b[^"'`\n]*["'`]/gi) ?? [], f).toEqual([]);
  expect(html).not.toMatch(/(leaves?|stays? on|on) your (phone|computer|laptop)\b/i);
  expect(t).toMatch(/\bAI\b/); expect(t).toMatch(/device/);
  const METHOD = /\b(whisper|webgpu|wasm|webassembly|webcodecs|mediapipe|blazeface|hugging ?face|jsdelivr|onnx|tensorflow|mediabunny|ffmpeg|neural|machine learning|face (tracker|detector|detection|recognition)|h\.?264|vp9|opus)\b/i;
  expect(t.split(/\n|(?<=[.!?])\s/).filter((l) => METHOD.test(l))).toEqual([]);
  // It tells the faces in one recording apart so as not to repeat a close-up, and says so, and says that nothing about a
  // face outlasts the recording. It does not claim that it cannot tell people apart.
  expect(t).toMatch(/tells the faces in one recording apart/); expect(t).toMatch(/Nothing about a face is kept after the recording stops/);
  expect(t).not.toMatch(/does not (know|recogni[sz]e|identify)/i);
  // Face information is read in the page and not sent (GDPR Art. 9 / BIPA research, round 7): the page says so where it says where the video goes.
  expect(t).toMatch(/faces are read inside this page, not sent to us or anyone/);
});

opTest("Operator shows a sample to watch before the camera opens, credited, under the host's per-file limit", () => {
  // Design review r4 B1: at rest the stage was a black box. The sample is the demo video of the real page at work.
  const html = read(`${OP.dist}/index.html`);
  const tag = html.match(/<video[^>]*\bid="sample"[^>]*>/)?.[0] ?? "";
  expect(tag, "a sample video in the stage").toMatch(/\bsrc="demo\.mp4"/); expect(tag).toMatch(/\bposter="demo\.jpg"/); expect(tag).toMatch(/\bplaysinline\b/);
  expect(html.indexOf('id="sample"'), "the sample is inside the stage").toBeGreaterThan(html.indexOf('id="stage"'));
  expect(html.indexOf('id="sample"')).toBeLessThan(html.indexOf('id="commands"'));
  for (const [f, max] of [["demo.mp4", 25e6], ["demo.jpg", 300e3]] as const) { const p = join(ROOT, OP.dist, f); expect(existsSync(p), f).toBe(true); expect(statSync(p).size, f).toBeLessThan(max); }
  const url = read("operator/app/tests/fixtures/SOURCES.md").match(/https:\/\/www\.youtube\.com\/watch\?v=[\w-]+/)?.[0];
  expect(html, "the sample's footage is credited").toMatch(new RegExp(`<a href="${url!.replace(/[?.]/g, "\\$&")}" rel="noopener">[^<]*NASA</a>`));
  // The court scene is a Creative Commons clip (CC BY 3.0): credited where it plays, as the licence asks.
  const court = read("operator/app/tests/fixtures/SOURCES.md").match(/https:\/\/commons\.wikimedia\.org\/wiki\/File:[\w.-]+/)?.[0];
  expect(court, "SOURCES.md names the court clip").toBeTruthy();
  expect(html, "the court footage is credited").toMatch(new RegExp(`<a href="${court!.replace(/[?.]/g, "\\$&")}" rel="noopener">[^<]*CC BY</a>`));
  expect(read(`${OP.dist}/_headers`), "a replaced demo reaches visitors at once").toMatch(/^\/demo\.(mp4|\*)\n\s+Cache-Control: no-cache/m);
});

opTest("Operator's sample plays in the studio's player: the same scrub line and sound button as the other tools, no native controls", () => {
  const seekMarkup = (file: string) => read(file).match(/<input class="seek"[^\n]*/)?.[0];
  expect(read("operator/app/src/seek.ts"), "the Operator's sample scrubs with the same line").toBe(read("vertical/app/src/seek.ts"));
  expect(seekMarkup("operator/app/dist/index.html")).toBe(seekMarkup("vertical/app/dist/index.html")!);
  const sound = (file: string) => read(file).match(/<button class="sound" id="sound"[\s\S]*?<\/button>/)?.[0];
  expect(sound("operator/app/dist/index.html"), "the Operator's sample has the same sound button").toBe(sound("vertical/app/dist/index.html")!);
  expect(read("operator/app/dist/index.html"), "the browser's own controls do not cover the sample's captions").not.toMatch(/<video id="sample"[^>]*\bcontrols\b/);
});

opTest("Operator loads nothing from other companies, and sends only the numbers a person chooses to send", () => {
  const html = read(`${OP.dist}/index.html`);
  for (const m of html.matchAll(/<(?:script|link|img|video|source|iframe)\b[^>]*\b(?:src|href)=["'](https?:\/\/[^"']+)["'][^>]*>/g)) expect(m[1]).toMatch(/^https:\/\/([a-z]+\.)?smaverk\.com\//);
  for (const m of html.matchAll(/href="([^"]*\b(privacy|terms)\b[^"]*)"/g)) expect(m[1]).toMatch(/^https:\/\/smaverk\.com\/(privacy|terms)$/);
  const hosts = new Set<string>(); for (const f of OP.src) for (const m of code(read(f)).matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) hosts.add(m[1]!);
  hosts.delete("odml.pa.googleapis.com"); // matched so it can be answered on the device with an empty 204; it is not contacted
  expect([...hosts]).toEqual(["unlock.smaverk.com"]); // the Send numbers button, shown only with ?debug
  expect(read(OP.src[0]!)).toMatch(/if \(DEBUG\) \{[\s\S]*unlock\.smaverk\.com\/lab/);
});

opTest("Operator shows what it does in pictures: one moving diagram per mode, the controls on the picture, few words", () => {
  // The principal, 2026-09-27: "the how to use and description in general sucks, it doesn't reflect the operator now … less
  // words and more diagrams". Each mode is the picture the camera sees (its shot in green) beside the video it makes.
  const html = read(`${OP.dist}/index.html`);
  expect(wordsAtRest(html), "well under the 234 words the text version had").toBeLessThanOrEqual(200);
  const cards = [...(html.match(/<div class="dg-modes">[\s\S]*?<\/div>/)?.[0] ?? "").matchAll(/<figure class="dg-card">([\s\S]*?)<\/figure>/g)].map((m) => m[1]!);
  const chips = [...html.matchAll(/<button class="chip" data-cmd="\w+"[^>]*><span class="short">([^<]+)</g)].map((m) => m[1]!.replace("&#39;", "'"));
  expect(cards.map((c) => c.match(/<figcaption><b>([^<]+)<\/b>/)?.[1]), "a diagram for each command, in the chips' order").toEqual(chips);
  for (const c of cards) {
    expect(c, "a drawing, not a picture file or a library").toMatch(/^<svg class="dg" viewBox/);
    const words = c.match(/<\/b>([^<]*)<\/figcaption>/)![1]!.trim().split(/\s+/).length; expect(words, c.slice(-80)).toBeLessThanOrEqual(8);
  }
  // Moving, and still under reduced motion: every animated shot also has a resting transform (the page's reduced-motion rule
  // stops every animation, and the resting one is the frame shown then); no script draws them.
  expect(html).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\*\{animation:none!important/);
  for (const k of ["eF", "eC", "fF", "fC", "tF", "tC"]) expect(html, `.dg-${k}`).toMatch(new RegExp(`\\.dg-${k}\\{transform:[^;]+;animation:dg[A-Z]{2} `));
  expect([...html.matchAll(/<script\b[^>]*\bsrc="(?!https:\/\/events\.smaverk\.com\/c\.js")/g)].length, "one script: the app (the shared count script aside)").toBe(1);
  // The controls diagram names each control on the picture, and the facts the text used to carry are still said.
  const ctl = html.match(/<svg class="dg-ctl"[\s\S]*?<\/svg>/)?.[0] ?? "";
  for (const l of ["Turn off", "Light", "Shape", "Zoom", "What to film", "Switch camera", "Close-up time", "Hold to stop"]) expect(ctl, l).toContain(l);
  const t = text(html), llms = read(`${OP.dist}/llms.txt`);
  for (const f of [/a still of each face/, /camera turns off when you leave the page/]) { expect(t, String(f)).toMatch(f); expect(llms, `llms.txt ${f}`).toMatch(f); }
  expect(llms, "llms.txt: free, no key").toMatch(/Free, with no account and no key/);
  expect(t + llms, "no preview wording left").not.toMatch(/while (in|it is a) preview/i);
});

// ---------------------------------------------------------------------------------------------------------
// Clips. It is in SITES, so everything above applies to it; what is left is what is true of this tool only: it is
// the other three tools' own code in a row, its price is one constant, its cap is one constant, and it has no
// checkout yet, so the placeholders must not look like one.
// ---------------------------------------------------------------------------------------------------------
test("Clips wears the studio's clothes: every style rule Captions also has is identical", () => {
  const ALLOWED = new Set([".demo", ".chips", ".chip", ".chip canvas", ".chip span", ".result", ".caplabel", ".caplabel b", "details p", "input,textarea", ".step"]); // the clip finder's own shapes, which Clips takes over; and .step, whose notes in Clips ("clip 1 of 3: finding the speaker 45%") are long enough to squeeze the label to one letter a line in Captions' three columns (design review 3, B6)
  const rules = (file: string) => {
    const css = [...read(file).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/@media[^{]+\{([\s\S]*?\})\s*\}/g, " ");
    const out = new Map<string, string>();
    for (const r of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) for (const sel of r[1]!.split(",")) out.set(sel.trim(), r[2]!.trim().replace(/;$/, ""));
    return out;
  };
  const a = rules("captions/app/dist/index.html"), b = rules("clips/app/dist/index.html");
  const drift: string[] = []; let shared = 0;
  for (const [sel, body] of a) if (b.has(sel)) { shared++; if (b.get(sel) !== body && !ALLOWED.has(sel)) drift.push(sel); }
  expect(shared).toBeGreaterThan(50);
  expect(drift).toEqual([]);
});

test("Clips: the cap is one constant, the page states it, and every clip saves with no mark", () => {
  const app = read("clips/app/app.ts"), plan = read("clips/app/src/lib/plan.ts"), html = read("clips/app/dist/index.html");
  expect(code(app), "no price, free-save count or mark in the script").not.toMatch(/PRICE|freeSaved|FREE_KEY|mark: !|drawMark/);
  expect(code(read("clips/app/src/make.ts")), "make.ts draws no mark").not.toMatch(/drawMark|job\.mark/);
  expect(code(read("captions/app/src/draw.ts")), "the shared drawing has no mark").not.toMatch(/drawMark/);
  expect(plan, "the cap").toMatch(/export const MAX_CLIP_S = 90;/);
  expect(text(html), "the page states the cap").toMatch(/up to 90 seconds/);
  expect(text(read("clips/app/dist/llms.txt"))).toMatch(/up to 90 seconds/);
  // The clips are the other tools' own code, imported, not copied.
  const make = read("clips/app/src/make.ts");
  for (const m of ["vertical/app/src/detect", "vertical/app/src/fastsave", "vertical/app/src/lib/track", "captions/app/src/draw", "captions/app/src/lib/lines", "clipfinder/app/src/lib/decode"]) expect(make, `make.ts uses ${m}`).toContain(`/${m}"`);
  expect(read("clips/app/finder.ts")).toContain('import "../../clipfinder/app/worker"');
  expect(read("clips/app/listen.ts")).toContain('import "../../captions/app/worker"');
  // No key and no bundle: nothing says a key opens anything.
  for (const [f, t] of [["page", text(html)], ["llms.txt", read("clips/app/dist/llms.txt")], ["terms", text(read(LEGAL[1]!))]] as const) expect(t, `${f}: no key story`).not.toMatch(/also opens|key opens|Clips key/i);
  // It promises only what it measures.
  const both = text(html) + read("clips/app/dist/llms.txt");
  for (const claim of [/\bviral/i, /best moments/i, /will perform/i, /\bengagement\b/i, /\bguarantee/i]) expect(both).not.toMatch(claim);
  expect(both).toMatch(/does not (guess|predict)/i);
  // The sample is the NASA recording the clip finder uses, credited where it shows.
  expect(html).toContain("https://images.nasa.gov/details/iss071m261311538_NASA_Astronaut_Matt_Dominick_Talks_with_KMGH_Denver_240510");
});

// The cold user (2026-09-25) found the sample clips stopping at 20 s while their cards said about a minute.
test("Clips: the sample clips are as long as their cards say", () => {
  // An mp4's length, from its movie header: [size][mvhd][version][flags] then v0: 4+4 bytes of dates, v1: 8+8.
  const mp4Seconds = (file: string) => {
    const b = readFileSync(join(ROOT, file)); const at = b.indexOf("mvhd"); expect(at, `${file}: an mp4 movie header`).toBeGreaterThan(0);
    const v1 = b[at + 4] === 1, p = at + 8 + (v1 ? 16 : 8), scale = b.readUInt32BE(p);
    return (v1 ? Number(b.readBigUInt64BE(p + 4)) : b.readUInt32BE(p + 4)) / scale;
  };
  const s = JSON.parse(read("clips/app/dist/sample.json"));
  expect(s.moments.length).toBe(3);
  for (const m of s.moments) {
    expect(m.lengthS, `${m.clip}: the card's length is the moment's`).toBeCloseTo(m.endS - m.startS, 0);
    expect(Math.abs(mp4Seconds(`clips/app/dist/${m.clip}`) - m.lengthS), `${m.clip} plays as long as its card says`).toBeLessThan(0.5);
  }
});

// The same round found no word anywhere on what size a clip comes out. The size is Vertical's outputSize: the
// recording's full height, 9:16, not enlarged. Every place that states it names the same numbers, and they are that function's.
test("Clips: what comes out is stated the same everywhere, and is what the save writes", async () => {
  const { outputSize } = await import("../vertical/app/src/lib/track");
  expect(outputSize(1920, 1080), "a 1080p recording").toEqual({ width: 608, height: 1080 });
  expect(outputSize(1280, 720), "a 720p recording").toEqual({ width: 406, height: 720 });
  const html = read("clips/app/dist/index.html");
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!;
  const meta = (p: string) => html.match(new RegExp(`<meta (?:name|property)="${p}" content="([^"]*)"`))?.[1] ?? "";
  const card = read(STUDIO).split("<article").find((a) => /<h3>Clips<\/h3>/.test(a)) ?? "";
  const terms = text(read(LEGAL[1]!)).replace(/\s+/g, " ");
  const places: [string, string][] = [
    ["the page, under the tool", html.match(/<p class="fine" id="caphint">([^<]*)</)?.[1] ?? ""],
    ["the page, what it does", html.match(/<summary>What it does[\s\S]*?<\/details>/)?.[0] ?? ""],
    ["description", meta("description")], ["og:description", meta("og:description")], ["twitter:description", meta("twitter:description")],
    ["JSON-LD", JSON.parse(ld).description], ["llms.txt", read("clips/app/dist/llms.txt")],
    ["terms", terms.match(/In Clips [^.]*\./)?.[0] ?? ""],
  ];
  // The studio card says it in plain words and leaves the number to the page (studio design review, four cards, B2);
  // if a size comes back to it, it is this one.
  places.push(...(/\d+\s*×\s*\d+/.test(text(card)) ? [["the studio card", text(card)] as [string, string]] : []));
  expect(text(card), "the studio card: no size a clip does not come out at").not.toMatch(/1080\s*[×x]\s*1920|\b4K\b/);
  for (const [where, t] of places) expect(t, `${where} states the size of a clip from a 1080p recording`).toContain("608×1080");
  for (const [where, t] of places) expect(t, `${where}: no size a clip does not come out at`).not.toMatch(/1080\s*[×x]\s*1920|\b4K\b/);
  // The finished-clip line says the size of the clip actually made, not a stated one.
  expect(code(read("clips/app/app.ts"))).toMatch(/MP4, 9:16, \$\{[^}]*\.width\}×\$\{[^}]*\.height\}/);
});

// The page said a clip took "about as long as it plays". Measured 2026-09-26 (.github/workflows/webkit.yml, the Chromium
// row on a four-core runner): two 1080p clips of 61 and 65 s in 67 s, and five minutes read in 37 s; the cold user's
// 18:57 read in 2:16. So the page and llms.txt state those, and no longer the old line.
test("Clips: the time it takes is the measured one, the same on the page and in llms.txt", () => {
  for (const [f, t] of [["page", text(read("clips/app/dist/index.html"))], ["llms.txt", read("clips/app/dist/llms.txt")]] as const) {
    expect(t, `${f}: the old claim`).not.toMatch(/about as long as it plays/);
    expect(t, `${f}: the reading time`).toMatch(/an hour of recording (in|is read in) about 7 minutes/);
    expect(t, `${f}: the clip time`).toMatch(/each clip takes about half as long as it plays/);
    expect(t, `${f}: the phone limit`).toMatch(/iPhone.*(small screen|small-screen)/);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The top bar. The principal, 2026-09-27: "smaverk.com doesn't have the smaverk logo on top clickable and there are no
// dark and light buttons even though they are supposed to be there." One brand link and one light/dark button, the same
// bytes on every page; the device's setting until a tap picks one, and a picked theme wins over every dark-mode rule.
// ---------------------------------------------------------------------------------------------------------

// The public mirror carries no Operator page (its code stays here, as opTest says): each page is checked where it is.
const TOP_PAGES = [STUDIO, HOME, "captions/app/dist/index.html", "vertical/app/dist/index.html", "clipfinder/app/dist/index.html", "clips/app/dist/index.html", "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
const themeParts = (html: string) => ({
  head: html.match(/<script>\/\* theme:[\s\S]*?<\/script>/)?.[0],
  css: html.match(/\/\* theme toggle:[\s\S]*?\/\* \/theme toggle \*\//)?.[0],
  button: html.match(/<button class="theme" id="theme"[\s\S]*?<\/button>/)?.[0],
});
// Each rule inside an @media block, with braces matched, as [media query, selector, body].
const mediaRules = (css: string) => {
  const out: [string, string, string][] = [];
  for (const m of css.matchAll(/@media([^{]+)\{/g)) {
    let i = m.index! + m[0].length, depth = 1; const start = i;
    while (i < css.length && depth) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    for (const r of css.slice(start, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push([m[1]!.trim(), r[1]!.trim(), r[2]!.trim()]);
  }
  return out;
};

test("every page's top bar: the brand links home, and the light/dark button is the same on every page", () => {
  const first = themeParts(read(TOP_PAGES[0]!));
  expect(first.head && first.css && first.button, "the studio has all three parts").toBeTruthy();
  for (const p of TOP_PAGES) {
    const html = read(p), parts = themeParts(html);
    expect(html, `${p}: brand link`).toMatch(/<div class="top"><a class="brand" href="https:\/\/(video\.)?smaverk\.com"><i><\/i>Småverk/);
    expect(parts, p).toEqual(first);
    // Inside the top bar, and the stored pick is applied in <head>, before anything is painted.
    expect(html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0], `${p}: button in the top bar`).toContain(first.button!);
    expect(html.indexOf(first.head!), `${p}: theme script in head`).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf(first.head!)).toBeLessThan(html.indexOf("<style"));
  }
  // What it does: remembered (guarded), explicit, both the scheme and the attribute set, and a label that says what a tap does.
  const js = first.head!;
  for (const need of ["localStorage.getItem", "localStorage.setItem", "try{", "style.colorScheme", 'setAttribute("data-theme"', '"aria-pressed"', "Switch to light mode", "Switch to dark mode"]) expect(js).toContain(need);
  expect(first.css).toMatch(/\.theme\{[^}]*width:44px;height:44px/);
  expect(first.button).toMatch(/class="moon"/); expect(first.button).toMatch(/class="sun"/);
});

test("the light/dark pick carries across the studio: one cookie for .smaverk.com, on every page incl. the search pages, Privacy and Terms", () => {
  // Design review r8 X1: localStorage belongs to one site, and smaverk.com and each tool are six sites, so a pick made on
  // the studio was lost one tap later. The cookie is read first, then this site's storage; a tap writes both.
  const first = themeParts(read(TOP_PAGES[0]!));
  const all = [...TOP_PAGES, ...LEGAL, ...Object.values(SITES).flatMap((s) => search(s).map((f) => `${s.dist}/${f}`))];
  for (const p of all) {
    const html = read(p), parts = themeParts(html);
    expect(parts.head, `${p}: the theme script`).toBe(first.head!); expect(parts.css, `${p}: the toggle CSS`).toBe(first.css!); expect(parts.button, `${p}: #theme`).toBe(first.button!);
    expect(html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0], `${p}: brand link and button in the top row`).toMatch(/<a class="brand" href="https:\/\/(video\.)?smaverk\.com"><i><\/i>Småverk[\s\S]*<button class="theme" id="theme"/);
    expect(html.indexOf(first.head!), `${p}: theme script before any style`).toBeLessThan(html.indexOf("<style"));
  }
  const js = first.head!;
  expect(js).toContain('document.cookie.match(/(?:^|; )smaverk-theme=(light|dark)/)');
  expect(js.indexOf("document.cookie.match")).toBeLessThan(js.indexOf("localStorage.getItem"));
  for (const need of ["Domain=.smaverk.com", "Path=/", "Max-Age=31536000", "SameSite=Lax", "Secure"]) expect(js, need).toContain(need);
  // Privacy names the cookie (it also says the analytics count visits without cookies), and so does every llms.txt.
  expect(text(read(LEGAL[0]!)).replace(/\s+/g, " ")).toContain("If you pick light or dark, one small cookie remembers that choice across the tools. It holds nothing else.");
  for (const f of ["captions", "vertical", "clipfinder", "clips", "operator"].map((t) => `${t}/app/dist/llms.txt`).filter((f) => existsSync(join(ROOT, f)))) expect(read(f), f).toContain("`smaverk-theme` cookie for `.smaverk.com`");
});

test("Operator: one set of mode names everywhere (Everyone / Follow / Talking), and a sample that is the program, playing at rest", () => {
  // Design review r8 O1: the chooser said "Talking the speaker", the diagrams "Who's talking", the camera bar "Talking".
  const f = "operator/app/dist/index.html"; if (!existsSync(join(ROOT, f))) return; // no Operator page in the public mirror
  const html = read(f);
  expect([...html.matchAll(/<button class="chip" data-cmd="[a-z]+"[^>]*><span class="short">([^<]+)<\/span><small>([^<]+)<\/small><\/button>/g)].map((m) => `${m[1]} / ${m[2]}`)).toEqual(["Everyone / each face", "Follow / one person", "Talking / who speaks"]);
  expect([...html.matchAll(/<figcaption><b>([^<]+)<\/b>/g)].map((m) => m[1]).slice(0, 3)).toEqual(["Everyone", "Follow", "Talking"]);
  for (const p of [f, "operator/app/dist/llms.txt", STUDIO, "operator/app/src/lib/words.ts", "operator/app/app.ts"]) {
    const t = p.endsWith(".ts") ? [...code(read(p)).matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => m[1] ?? m[2]).join("\n") : read(p);
    expect(t, p).not.toMatch(/Everyone, once|Follow this one|Who's talking|class="long"/);
  }
  // O3: muted, looping, playing at rest, with the mode named on the picture from the chapter lines make-demo writes.
  const v = html.match(/<video id="sample"[^>]*>/)?.[0] ?? "";
  for (const a of [" muted", " autoplay", " loop", " playsinline"]) expect(v, a).toContain(a);
  expect(v).not.toContain(" controls");
  const lines = JSON.parse((v.match(/data-lines="([^"]*)"/)?.[1] ?? "[]").replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as [number, string][];
  expect(lines.map((l) => l[1].split(":")[0])).toEqual(["Everyone", "Follow", "Talking"]);
  expect(html).toContain('<p class="chapline" id="chapline" aria-hidden="true"></p>');
});

test("the light/dark button: no hover circle on touch, on the 16 px grid, a visible focus ring; the top row in one place on every page", () => {
  // Design review r8 X2: a :hover outside (hover:hover) sticks after a tap on a phone; -12 px pushed it into the price tag.
  const css = themeParts(read(TOP_PAGES[0]!)).css!;
  expect(css.replace(/@media\s*\(hover:\s*hover\)\{[^{}]*\{[^{}]*\}\}/g, ""), "a :hover rule outside @media(hover:hover)").not.toMatch(/:hover/);
  expect(css).toContain("@media(hover:hover){.theme:hover{background:var(--line)}}");
  expect(css).toMatch(/\.theme\{[^}]*margin:0 -10px 0 -4px/);
  expect(css).toContain(".theme:focus-visible{outline:2px solid var(--ink);outline-offset:-4px}");
  // S1: the studio's column is 880 px and the legal pages' 640 px, the tools' 1100 px; the top row spans the tools' width
  // everywhere, so the brand and the button do not move under the pointer from page to page.
  for (const p of [STUDIO, HOME, ...LEGAL]) expect(read(p), p).toContain(".top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:");
  for (const p of [STUDIO, HOME, ...LEGAL]) expect(read(p), p).toMatch(/\.top\{[^}]*margin-inline:calc\(\(100% - min\(1100px, 100vw - 32px\)\) \/ 2\)/);
  for (const p of TOP_PAGES.filter((p) => p !== STUDIO && p !== HOME)) expect(read(p), p).toMatch(/\.wrap\{max-width:1100px;/);
});

test("a picked theme wins: every dark-mode rule has its data-theme twin, on every page", () => {
  const miss: string[] = [];
  for (const p of TOP_PAGES) {
    const css = [...read(p).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
    const flat = css.replace(/@media[^{]+\{/g, "\n"); // every rule, media or not, for the twin lookup
    for (const [q, sel, body] of mediaRules(css)) {
      const scheme = q.match(/prefers-color-scheme:\s*(dark|light)/)?.[1]; if (!scheme) continue;
      const other = scheme === "dark" ? "light" : "dark";
      for (const s of sel.split(",").map((x) => x.trim())) {
        const guard = `:root:not([data-theme=${other}]) `;
        if (!s.startsWith(guard)) { miss.push(`${p}: "${s}" in @media ${q} does not yield to a picked ${other} theme`); continue; }
        const twin = `:root[data-theme=${scheme}] ${s.slice(guard.length)}`;
        if (!flat.split("\n").some((l) => l.includes(`${twin}{${body}}`))) miss.push(`${p}: no "${twin}{${body}}"`);
      }
    }
    // Scripts on the page that ask the device for its scheme: only the theme script itself.
    const scripts = read(p).replace(/<script>\/\* theme:[\s\S]*?<\/script>/, "");
    if (/prefers-color-scheme/.test(scripts.replace(/<style[\s\S]*?<\/style>/g, ""))) miss.push(`${p}: a script reads the device's scheme without the picked theme`);
  }
  // A canvas that picks colours for the scheme reads the picked theme too, and redraws when it changes.
  for (const f of ["captions/app/app.ts", "vertical/app/app.ts", "clipfinder/app/app.ts", "clips/app/app.ts", "operator/app/app.ts"].filter((f) => existsSync(join(ROOT, f)))) { // no Operator code in the public mirror
    const src = code(read(f)); if (!/prefers-color-scheme/.test(src)) continue;
    if (!/data-theme/.test(src) || !/"themechange"/.test(src)) miss.push(`${f}: reads the device's scheme but not the picked theme`);
  }
  expect(miss).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------
// Quality pass, 2026-09-27 (the principal: "use better material for the marketing or what the tool does… less words and
// more diagrams"). Pictures carry what words used to: each one is drawn inline (no image file), says what it shows to a
// screen reader, and follows the theme. And the facts it touched stay rippled.
// ---------------------------------------------------------------------------------------------------------
test("quality pass: the pictures that replaced words, and the facts they carry", () => {
  const studio = read(STUDIO), t = text(studio).replace(/\s+/g, " ");
  // Every tool: six facts, each an icon and a few words (was "How they work", over a list of promises; studio cold user 4).
  const facts = studio.match(/<ul class="facts">([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const items = [...facts.matchAll(/<li><span class="ic" aria-hidden="true"><svg [\s\S]*?<\/svg><\/span>([^<]+)<\/li>/g)].map((m) => m[1]!);
  expect(items).toEqual(["Works offline once loaded", "Nothing uploaded", "No account", "Free, every tool in full", "No mark on your videos", "No ads"]);
  for (const i of items) expect(i.split(" ").length, i).toBeLessThanOrEqual(6);
  // The Operator card leads with the job, not a list of modes (A, 2026-09-30: "the operator does a lot more"): it works the
  // camera (each face, one person, whoever talks) and hands over the video with a still of every face. Kept to three lines
  // on desktop so the text column ends with the demo, and the page stays under 240 words (design review r8, round 3).
  const op = text(studio.split("<article").find((a) => /<h3>Operator<\/h3>/.test(a)) ?? "");
  for (const f of [/works the camera/, /each face/, /follows one person/, /whoever talks/, /still of every face/]) expect(op, String(f)).toMatch(f);
  const opLine = /<h3>Operator<\/h3>\s*<p>([^<]+)<\/p>/.exec(studio)?.[1] ?? "";
  expect(opLine.split(/\s+/).filter(Boolean).length, "the Operator line fits three desktop lines").toBeLessThanOrEqual(31);
  expect(op, "the card is not a spec sheet").not.toMatch(/full-screen camera/);
  // Every llms.txt that lists the other tools names Operator; no page or llms.txt sells the maker.
  for (const f of ["captions/app/dist/llms.txt", "vertical/app/dist/llms.txt", "clipfinder/app/dist/llms.txt", "clips/app/dist/llms.txt"]) {
    expect(read(f), `${f} names Operator`).toContain("https://operator.smaverk.com");
    expect(read(f), `${f}: the maker is not the pitch`).not.toMatch(/one-person|one person studio|made by one person/i);
  }
  expect(studio, "studio: the maker is not the pitch").not.toMatch(/[Mm]ade by one person|one-person/);
  // Captions and Vertical point at each other with a picture of what the other tool does, the same block in both.
  for (const [p, to] of [["captions/app/dist/index.html", "vertical"], ["vertical/app/dist/index.html", "captions"]] as const) {
    const x = read(p).match(/<div class="xlink"><svg [^>]*aria-hidden="true">[\s\S]*?<\/svg><p>[^<]*<a href="https:\/\/([a-z]+)\.smaverk\.com\/\?src=[a-z]+">/);
    expect(x?.[1], `${p}: the picture link to ${to}`).toBe(to);
  }
  // Clips: the headline as a picture, named for a screen reader, its motion off for anyone who asked for less.
  const clips = read("clips/app/dist/index.html");
  expect(clips).toMatch(/<div class="flow" role="img" aria-label="[^"]{30,}"><svg /);
  expect(clips).toMatch(/@media\(prefers-reduced-motion:no-preference\)\{\.flow \.head\{animation:/);
});

// ---------------------------------------------------------------------------------------------------------
// Cold-user rounds, 2026-09-27 (Operator r8 finding 3, studio-4/captions-6/clipfinder-2/clips-2). What a script shows the
// visitor follows the same wording rules as the page: the site test read only HTML, so Operator's camera line said "Turn
// the phone sideways" and nothing caught it. Every string passed to say(…) or set as textContent in an app's source.
// ---------------------------------------------------------------------------------------------------------
test("status lines a script shows: \"device\", and no never/ever/forever", () => {
  const bad: string[] = [];
  for (const tool of ["captions", "vertical", "clipfinder", "clips", "operator"]) {
    const dir = join(ROOT, tool, "app"); if (!existsSync(join(dir, "app.ts"))) continue;
    const files = ["app.ts", ...(existsSync(join(dir, "src")) ? readdirSync(join(dir, "src"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => "src/" + f) : [])];
    for (const f of files) {
      const src = code(readFileSync(join(dir, f), "utf8"));
      for (const m of src.matchAll(/(?:\bsay\(|\.textContent\s*=)([^;\n]{0,400})/g))
        for (const s of m[1]!.matchAll(/"([^"\n]*)"|`([^`\n]*)`|'([^'\n]*)'/g)) { const lit = s[1] ?? s[2] ?? s[3] ?? ""; if (/\b(phone|computer|never|ever|forever)\b/i.test(lit)) bad.push(`${tool}/app/${f}: "${lit.slice(0, 90)}"`); }
    }
  }
  expect(bad).toEqual([]);
});

test("Vertical: one short line over the sample, the same in the page, its search page and the script", () => {
  // Vertical cold user 6 (2026-09-27): four lines of instructions sat above the sample and repeated what it shows.
  const src = read("vertical/app/app.ts").match(/s === "sample" \? "([^"]+)"/)?.[1] ?? "";
  expect(src.split(/\s+/).length, src).toBeLessThanOrEqual(10);
  for (const f of ["vertical/app/dist/index.html", "vertical/app/dist/capcut-auto-reframe-alternative.html"]) expect(read(f).match(/<span id="hint">([^<]*)<\/span>/)?.[1], f).toBe(src);
});

test("Clip finder: the moment, not a caveat, on the studio card; its reasons in plain words", () => {
  // Studio cold user 4 and Clip finder cold user 2 (2026-09-27): the card's overlay read "12:03 · Needs a line of setup
  // first", which a stranger reads as an error, and "setup" is jargon.
  const studio = read(STUDIO);
  expect(studio).not.toMatch(/m\.why\?\.\[0\]/); expect(studio).toMatch(/Math\.round\(m\.endS - m\.startS\)\} s · /);
  for (const f of ["clipfinder/app/src/lib/rank.ts", "clipfinder/app/dist/sample.json", "clips/app/dist/sample.json", "captions/app/dist/studio-demo/clipfinder-sample.json"].filter((f) => existsSync(join(ROOT, f)))) expect(read(f), f).not.toMatch(/line of setup/i);
  expect(text(studio.split("<article").find((a) => /<h3>Clip finder<\/h3>/.test(a)) ?? "")).toMatch(/Free\. It reads up to four hours of a recording\./);
});

test("Captions: no seconds-left guess before the pace is measured; Clip finder's sample plays at rest; Clips names read as words", () => {
  // Captions cold user 6 (2026-09-27): the first estimate said "about 66 s left" and it finished in 20 s.
  expect(code(read("captions/app/app.ts"))).toMatch(/const left = \(\) => \(done \? [^:]+ : measuredHere \? est - elapsed\(\) : -1\)/);
  // Clip finder cold user 2: the sample stood still behind a play button. At rest the strongest moment plays muted.
  const cf = code(read("clipfinder/app/app.ts"));
  expect(cf).toMatch(/showSample\(\);\s*previewSample\(\);/); expect(cf).toMatch(/prefers-reduced-motion: reduce/);
  // Clips cold user 2: "weekly-live-5-min-01-at-2-20.mp4" read as a code.
  expect(read("clipfinder/app/src/lib/naming.ts")).toMatch(/- clip \$\{index\} \(\$\{at\(startS\)\}\)\.\$\{ext\}/);
});

// Design review r8 (2026-09-27): Clips used the screen-reader-only class without its CSS, so "Sound off" showed on the video.
test("every page that uses class=\"sr\" hides it (defines .sr)", () => {
  for (const s of Object.values(SITES)) {
    const h = read(`${s.dist}/${s.page}`);
    if (/class="[^"]*\bsr\b/.test(h)) expect(h, `${s.dist}/${s.page} uses .sr without defining it`).toMatch(/\.sr\{[^}]*clip-path:inset\(50%\)/);
  }
});
