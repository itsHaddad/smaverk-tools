// site.test.ts: the ripple check. When one thing changes, the other places that state the same fact must change with it
// (the principal, 2026-09-18: a studio page whose Privacy link opened another tool's policy, a terms page still describing
// a feature as unfinished, "never" promises). No browser: runs in `bun test tests/` locally, in deploy.sh and on the runner.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
// A tool joins this list the day it gets a page, and every check below then applies to it. `prices` empty
// means it costs nothing today: the checks flip from "the price agrees everywhere" to "no price anywhere",
// because a number in front of a visitor that the owner has not given is the worse failure of the two.
// `limits` are the sentences that must appear wherever a searcher can land, since a limit discovered after
// the work is done is what earns one-star reviews. `copy` is where the page's own sentences live.
const SITES = {
  captions: { dist: "captions/app/dist", src: ["captions/app/app.ts", "captions/app/worker.ts"], prices: ["$19"], limits: ["60 seconds", "five minutes"], page: "index.html", host: "captions.smaverk.com", copy: "captions/app/app.ts", savedPrice: true },
  vertical: { dist: "vertical/app/dist", src: ["vertical/app/app.ts", "vertical/app/src/detect.ts", "vertical/app/src/fastsave.ts"], prices: ["$24", "$29"], limits: ["60 seconds", "five minutes"], page: "index.html", host: "vertical.smaverk.com", copy: "vertical/app/app.ts", savedPrice: true },
  clipfinder: { dist: "clipfinder/app/dist", src: ["clipfinder/app/app.ts", "clipfinder/app/worker.ts"], prices: ["$29"], limits: ["30 minutes", "four hours"], page: "index.html", host: "clipfinder.smaverk.com", copy: "clipfinder/app/src/lib/pricing.ts", savedPrice: false },
  clips: { dist: "clips/app/dist", src: ["clips/app/app.ts", "clips/app/src/make.ts", "clips/app/src/lib/plan.ts"], prices: ["$49"], limits: ["90 seconds", "four hours"], page: "index.html", host: "clips.smaverk.com", copy: "clips/app/app.ts", savedPrice: false },
} as const;
const STUDIO = "captions/app/dist/studio.html"; const LEGAL = ["captions/app/dist/privacy.html", "captions/app/dist/terms.html"];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const pages = () => Object.values(SITES).flatMap((s) => readdirSync(join(ROOT, s.dist)).filter((f) => /\.(html|txt)$/.test(f) && !/^google/.test(f)).map((f) => `${s.dist}/${f}`));
// The search pages (tools/pages.ts): every .html in a dist that is not one of the tool's hand-written pages.
const HAND = /^(index|studio|privacy|terms|google[0-9a-f]+)\.html$/;
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
  for (const p of pages()) for (const m of read(p).matchAll(/href="([^"]*\b(privacy|terms)\b[^"]*)"/g)) if (!/^https:\/\/smaverk\.com\/(privacy|terms)$/.test(m[1]!)) bad.push(`${p}: ${m[1]}`);
  expect(bad).toEqual([]);
  for (const l of LEGAL) { const h = read(l); expect(h).toContain(`<link rel="canonical" href="https://smaverk.com/`); for (const tool of ["Captions", "Vertical"]) expect(h).toContain(tool); }
});

// 2026-09-29: the gates had no usage data (Cloudflare samples at 10% and cannot see use), so every page loads the first-party
// count script (missions/events) and the privacy page says what it counts.
test("every page loads the Småverk count script, and the privacy page says what it counts", () => {
  const missing = pages().filter((f) => f.endsWith(".html") && !read(f).includes(`<script src="https://events.smaverk.com/c.js" defer></script>`));
  expect(missing).toEqual([]);
  expect(text(read(LEGAL[0]!))).toMatch(/We also count, per day, how often a tool is opened, a file is picked, a result is saved or shared, and a buy link is tapped/);
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
  const KNOWN: Record<string, RegExp> = { "api.polar.sh": /Polar/, "sandbox-api.polar.sh": /Polar/, "buy.polar.sh": /Polar/, "unlock.smaverk.com": /small service of ours/, "captions.smaverk.com": /./, "vertical.smaverk.com": /./, "clipfinder.smaverk.com": /./, "clips.smaverk.com": /./, "smaverk.com": /./ };
  const privacy = text(read(LEGAL[0]!)); const unknown: string[] = [];
  for (const s of Object.values(SITES)) for (const f of s.src) if (existsSync(join(ROOT, f))) for (const m of code(read(f)).matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) { const h = m[1]!; if (!KNOWN[h]) unknown.push(`${f}: ${h}`); else expect(privacy).toMatch(KNOWN[h]!); }
  expect(unknown).toEqual([]);
  expect(privacy).toMatch(/Cloudflare Web Analytics/); // the beacon is named; it is the one party that sees page visits
  // The tools fetch some of their files from public file hosts. The page says so as a category (the principal, 2026-09-18: do not
  // tell the world how the tools are built); it must keep saying so until every file is served from our own site.
  expect(privacy).toMatch(/public file hosts/);
});

test("each tool's price is the same wherever it is stated, a free tool states none, and the legal pages state none", () => {
  const studio = text(read(STUDIO));
  for (const [name, s] of Object.entries(SITES)) {
    const own = new Set<string>(s.prices); const found = new Set<string>();
    for (const f of [...every(s), "llms.txt"]) for (const m of text(read(`${s.dist}/${f}`)).replace(/\$\d+ a month/g, " ").matchAll(/\$\d+/g)) found.add(m[0]); // the home page, every search page, and what agents read. A rival's price is always written "$N a month" (we charge nothing monthly), so that form is theirs, not a drifted price of ours
    // A tool with a price says it in its script too. A free tool keeps its constant asleep there, so only
    // its pages are read here; that the constant is the single number in the script is checked further down.
    if (s.prices.length) for (const m of code(read(s.src[0]!)).matchAll(/["'`][^"'`\n]*(\$\d+)[^"'`\n]*["'`]/g)) if (!/\$\{/.test(m[0]!.slice(m[0]!.indexOf(m[1]!), m[0]!.indexOf(m[1]!) + 2))) found.add(m[1]!);
    expect([...found].filter((p) => !own.has(p)).map((p) => `${name}: ${p}`)).toEqual([]);
    if (s.prices.length) {
      expect(found.has(s.prices[0]!), `${name} page states ${s.prices[0]}`).toBe(true);
      expect(studio, `studio card for ${name}`).toContain(s.prices[0]!);
    } else {
      // Free today. Nothing a visitor reads may carry a number, and the card says what it costs in words.
      expect([...found], `${name}: a price on a page of a free tool`).toEqual([]);
      throw new Error(`${name} has no price, and every tool has one now`);
    }
  }
  for (const l of LEGAL) expect(text(read(l)).match(/\$\d+/g) ?? []).toEqual([]);
});

test("every limit a tool enforces is stated wherever a searcher can land", () => {
  // Hidden limits earn one-star reviews (Kapwing, Trustpilot, 12 Apr 2026), so each tool's own limits are
  // on every page of it, in what agents read, and in the script that enforces them.
  for (const s of Object.values(SITES)) for (const f of every(s)) { const t = text(read(`${s.dist}/${f}`)) + code(read(s.src[0]!)); for (const limit of s.limits) expect(t, `${s.dist}/${f}: ${limit}`).toMatch(new RegExp(limit, "i")); }
  const terms = text(read(LEGAL[1]!)); expect(terms).toMatch(/60 seconds/); expect(terms).toMatch(/five minutes/); expect(terms).toMatch(/four hours/); expect(terms).not.toMatch(/being finished|estimate/);
  // Every tool is named in both legal pages: one of them described a tool that did not exist yet, once.
  for (const l of LEGAL) for (const tool of ["Captions", "Vertical", "Clip finder", "Clips"]) expect(text(read(l)), `${l} names ${tool}`).toContain(tool);
});

test("each sitemap lists only pages on its own host", () => {
  const check = (file: string, host: string) => { for (const m of read(file).matchAll(/<loc>https:\/\/([^/<]+)/g)) expect(`${file}: ${m[1]}`).toBe(`${file}: ${host}`); };
  check("captions/app/dist/sitemap.xml", "captions.smaverk.com"); check("captions/app/dist/studio-sitemap.xml", "smaverk.com"); check("clipfinder/app/dist/sitemap.xml", "clipfinder.smaverk.com"); check("clips/app/dist/sitemap.xml", "clips.smaverk.com");
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

test("what it costs is on the first screen and in the Saved box, per tool", () => {
  // Both cold users, 2026-09-18: on the phone the price was one scroll away at arrival and absent after a save.
  for (const [name, s] of Object.entries(SITES)) {
    if (!s.prices.length) {
      // Free: the same place on the first screen, saying so, and no checkout for a visitor to find.
      const html = read(`${s.dist}/${s.page}`);
      const top = html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(top, `${name}: header tag says what it costs`).toMatch(/<a class="tag" id="tag" href="#price">[^<]*<b>Free[^<]*<\/b><\/a>/);
      expect(html, `${name}: the tag's target exists`).toContain('<div class="price" id="price">');
      continue;
    }
    const html = read(`${s.dist}/${s.page}`); const price = s.prices[0].replace("$", "\\$");
    const top = html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(top, `${name}: header price tag`).toMatch(new RegExp(`<a class="tag" id="tag" href="#price">[^<]*<b>${price} once</b></a>`));
    expect(html, `${name}: the tag's target exists`).toContain('<div class="price" id="price">');
    expect(html.match(/<a [^>]*id="r?buy"[^>]*>/g)!.every((a) => /target="_blank" rel="noopener"/.test(a)), `${name}: buy links open their own tab`).toBe(true);
    // The clip finder has no Saved box: it saves moments, not one clip, and its price sits beside the exports instead.
    if (!s.savedPrice) continue;
    expect(html, `${name}: Saved box states the price with a link to the checkout`).toMatch(new RegExp(`<span id="rmark">[^<]*<a id="rbuy" href="https://[^"]+"[^>]*>${price} once</a>[^<]*five minutes[^<]*</span>`));
    expect(code(read(s.src[0]!)), `${name}: both buy links get the checkout address`).toMatch(/\["buy", "rbuy"\]/);
    // Cold user, 2026-09-19: the checkout opened in the same tab and Back wiped the clip. Both links open their own tab; the first tab picks the key up.
    expect(html.match(/<a [^>]*id="r?buy"[^>]*>/g)!.every((a) => /target="_blank" rel="noopener"/.test(a)), `${name}: buy links open their own tab`).toBe(true);
    // Design review 6, 2026-09-19: on every desktop the 440 px column broke the price in two ("$24" / "once") and its tap area lay over "Save again".
    expect(html, `${name}: the price in the Saved box stays in one piece`).toContain("#rbuy{white-space:nowrap}");
  }
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

test("the line under the main button reads the same in the page and in the script", () => {
  // 2026-09-19: the page said "Free up to 60 seconds…" and the script, after a key was removed, wrote a different sentence.
  for (const [name, s] of Object.entries(SITES)) {
    const inPage = read(`${s.dist}/${s.page}`).match(/<p class="trust" id="trust">([^<]*)<\/p>/)?.[1];
    expect(inPage, `${name}: trust line`).toBeTruthy();
    expect(code(read(s.copy)), `${name}: the script writes the page's sentence`).toContain(`"${inPage}"`);
  }
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
  const sv = [...read("captions/app/dist/index.html").matchAll(/calc\((\d+)svh \* var\(--ar/g)].map((m) => Number(m[1])); expect(sv.length).toBe(2); for (const v of sv) expect(v).toBeLessThanOrEqual(56);
});

test("every host has a sitemap of its own pages, and its robots.txt points at it", () => {
  // 2026-09-19: vertical.smaverk.com/sitemap.xml answered with the page itself (no such file) and its robots.txt named another host's sitemap.
  const want: Record<string, { dist: string; file: string; hosts: string[] }> = {
    "vertical.smaverk.com": { dist: "vertical/app/dist", file: "sitemap.xml", hosts: ["vertical.smaverk.com"] },
    "captions.smaverk.com": { dist: "captions/app/dist", file: "sitemap.xml", hosts: ["captions.smaverk.com", "smaverk.com"] }, // one deployment answers on both hosts
    "smaverk.com": { dist: "captions/app/dist", file: "studio-sitemap.xml", hosts: ["captions.smaverk.com", "smaverk.com"] },
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
  for (const p of ["captions/app/dist/index.html", "captions/app/dist/studio.html", "vertical/app/dist/index.html", "clipfinder/app/dist/index.html", "clips/app/dist/index.html"]) { const h = read(p); expect(h, `${p}: Search Console tag`).toMatch(/<meta name="google-site-verification" content="[\w-]{20,}">/); expect(h, `${p}: canonical`).toMatch(/<link rel="canonical" href="https:\/\/[a-z.]*smaverk\.com\/">/); expect(h, `${p}: description`).toMatch(/<meta name="description" content="[^"]{60,}">/); }
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
    expect(html, `${where}: the first-screen price tag`).toMatch(new RegExp(`<a class="tag" id="tag" href="#price">[^<]*<b>\\${s.prices[0]} once</b></a>`));
    expect(html, `${where}: the Saved box link`).toMatch(/<span id="rmark">[\s\S]*?<a id="rbuy" href="https:\/\/[^"]+"/);
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
  // The old line promised to "put it right or refund you" for any change, with no time limit. Refunds are bounded (14 days, once per person per tool),
  // changes carry a best-effort fix only, liability is capped at the price paid, mandatory consumer rights are kept (a clause that removes them is void).
  const terms = text(read(LEGAL[1]!)).replace(/\s+/g, " ");
  for (const must of [/first 14 days/, /once per person, per tool/, /After them we do not refund, unless the law of your country gives you a right we cannot set aside/, /given in its place and are the same length/, /provided as they are/, /as far as the law allows/i, /The most we can owe you in total for a tool is what you paid for it/, /not a promise that the tool will be offered/, /try to put it right/, /Do not share, publish, resell or rent/, /Swedish law applies/, /rights that the consumer law of your country gives you/, /By using a tool or buying a key you accept these terms/]) expect(terms).toMatch(must);
  for (const open of [/put it right or refund/i, /\bany time\b/i, /\bguarantee/i, /\blifetime\b/i, /\bunlimited\b/i, /money back whenever/i]) expect(terms).not.toMatch(open);
  // the one refund promise on the product pages is the bounded one, word for word
  for (const s of Object.values(SITES)) for (const f of readdirSync(join(ROOT, s.dist)).filter((f) => f.endsWith(".html") && !/^(google|privacy|terms)/.test(f))) { const t = text(read(`${s.dist}/${f}`)); for (const m of t.matchAll(/refund[^.]{0,60}/gi)) expect(`${f}: ${m[0].trim()}`).toMatch(/: Refund within 14 days/); }
});

// Clip finder is in SITES now, so everything above applies to it. What is left here is what is true of
// this tool and no other: a stricter list of words that would give away how it is built, a sample that is
// public-domain rather than CC BY, a dist where nothing is content-addressed, and the free-while-new rail
// with its one sleeping constant. A check that SITES already makes is not repeated.
const CF = { dist: "clipfinder/app/dist", src: ["clipfinder/app/app.ts", "clipfinder/app/worker.ts"], price: "$29", host: "clipfinder.smaverk.com" };
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
  // The sentence under the main button is one sentence, written once, and the script hands back the same one.
  // 2026-09-19: the page said one thing and the script, after a key was removed, wrote another. What matters is
  // that they agree — not the shape of the expression that produces it, which used to be pinned and stopped the
  // line being simplified when the free limit moved to #pricefine.
  const trust = html.match(/<p class="trust" id="trust">([^<]*)<\/p>/)?.[1];
  expect(trust, "trust line").toBeTruthy();
  expect(code(read("clipfinder/app/src/lib/pricing.ts")), "the script writes the page's sentence").toContain(`trust: "${trust}"`);
});

test("Clip finder: the owner's price, stated once and the same everywhere", () => {
  // Free while it was new from 2026-09-21; priced 2026-09-22 ($50 for an hour, then $29 from the evidence). The number lives in one named
  // constant, the pages say the same one, and the script holds no second.
  for (const f of ["index.html", "llms.txt"]) {
    const found = [...new Set(text(read(`${CF.dist}/${f}`)).replace(/\$\d+ a month/g, " ").match(/\$\d+/g) ?? [])];
    expect(found, `${f}: the price`).toEqual([CF.price]);
  }
  expect(read(CF.src[0]!), "the price is a single named constant in the script").toContain(`export const PRICE = "${CF.price}"`);
  expect([...new Set(code(read(CF.src[0]!)).match(/\$\d+/g) ?? [])], "no second price anywhere in the script").toEqual([CF.price]);
  expect(code(read("clipfinder/app/src/lib/pricing.ts")).match(/\$\d+/g) ?? [], "the paid sentences are written from the constant, not around it").toEqual([]);
  expect(code(read(CF.src[0]!)), "the trial is off").toMatch(/const TRIAL = false;/);
  // Hidden limits earn one-star reviews: both limits on the page, in llms.txt, and in the script that enforces them.
  for (const f of ["index.html", "llms.txt"]) { const t = text(read(`${CF.dist}/${f}`)); expect(t, `${f}: the free limit`).toMatch(/30 minutes/); expect(t, `${f}: the paid limit`).toMatch(/four hours/); }
  const app = read(CF.src[0]!);
  expect(app, "the free limit in the script").toMatch(/FREE_S = 30 \* 60/);
  expect(app, "the paid limit in the script").toMatch(/PAID_S = 4 \* 3600/);
  // The price is in the header, on the first screen, and its target exists; the checkout is the production link.
  const html = read(`${CF.dist}/index.html`);
  expect(html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0], "header tag").toContain(`<b>${CF.price} once</b>`);
  expect(html, "the tag's target").toContain('<div class="price" id="price">');
  const buy = html.match(/<a [^>]*id="buy"[^>]*>/)?.[0] ?? "";
  expect(buy, "the buy link opens its own tab").toMatch(/target="_blank" rel="noopener"/);
  expect(buy, "the buy link is shown").not.toMatch(/\shidden(\s|>)/);
  expect(buy, "and goes to the production checkout").toMatch(/href="https:\/\/buy\.polar\.sh\/polar_cl_/);
  expect(code(app), "the script knows the same checkout").toContain(buy.match(/href="([^"]+)"/)![1]!);
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
  const KNOWN = ["api.polar.sh", "sandbox-api.polar.sh", "buy.polar.sh", "unlock.smaverk.com", "captions.smaverk.com", "vertical.smaverk.com", "clipfinder.smaverk.com", "smaverk.com"];
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
// Unlocking. Three tools each inventing their own is how one of them ended up hiding its key box inside a shut
// fold-out, and another locked a paying customer out whenever the network was off. One file decides it now.
// ---------------------------------------------------------------------------------------------------------

const TOOLS = [
  { name: "captions", dist: "captions/app/dist", app: "captions/app/app.ts" },
  { name: "vertical", dist: "vertical/app/dist", app: "vertical/app/app.ts" },
  { name: "clipfinder", dist: "clipfinder/app/dist", app: "clipfinder/app/app.ts" },
  { name: "clips", dist: "clips/app/dist", app: "clips/app/app.ts" },
] as const;
const SHARED = TOOLS;
const UNLOCK_SRC = SHARED.map((t) => `${t.app.replace(/app\.ts$/, "")}src/lib/unlock.ts`);

test("unlocking cannot diverge: one unlock module, byte for byte, in every tool", () => {
  const first = read(UNLOCK_SRC[0]!);
  for (const p of UNLOCK_SRC.slice(1)) expect(read(p), `${p} differs from ${UNLOCK_SRC[0]}`).toBe(first);
  // The mechanism lives there and nowhere else: no tool may grow its own key check again.
  expect(first, "the module asks the worker what a key opens").toContain("/entitlements");
  // The audit fixture lives in the shared file too, at the length Polar issues: the design review's overlapping
  // tap targets only reproduced with a full-length key, because that is what wraps.
  // Scoped to the SAMPLE_KEY block: several other maps in this file are keyed by tool name too.
  const sample = first.slice(first.indexOf("export const SAMPLE_KEY"));
  for (const tool of TOOLS.map((t) => t.name)) {
    const m = sample.slice(0, sample.indexOf("};")).match(new RegExp(`${tool}: "([^"]+)"`));
    expect(m?.[1], `SAMPLE_KEY.${tool}`).toBeTruthy();
    expect(m![1]!.length, `SAMPLE_KEY.${tool} is a stub, not a real-length key`).toBeGreaterThanOrEqual(40);
  }
  expect(first, "the checkout return is handled there").toContain("checkout_id");
  expect(first, "the other tab's key is picked up there").toMatch(/addEventListener\("storage"/);
  for (const t of SHARED) {
    const app = code(read(t.app));
    expect(app, `${t.name}: uses the shared module`).toMatch(/from "\.\/src\/lib\/unlock"/);
    // A page may know the address of its own checkout; what it may no longer do is check a key itself.
    expect(app, `${t.name}: no page keeps its own key-check`).not.toContain("license-keys");
    expect(app, `${t.name}: no page asks Polar about a key`).not.toContain("customer-portal");
    // Every tool can be driven into the paid state, or its paid panel cannot be audited — which is how that
    // panel shipped unaudited in the first place. The clip finder lacked this and the phone UI gate found it.
    expect(app, `${t.name}: no way to force the paid state for an audit`).toMatch(/dbg\.setLicensed = /);
    expect(app, `${t.name}: the audit fixture is a real-length key, not a stub`).toContain(`SAMPLE_KEY.${t.name}`);
  }
});

test("a key already on the device survives our own downtime", () => {
  // The tools work offline once loaded, and the clip finder invites people to prove it by switching the network
  // off. A paid key must not evaporate when the check cannot be made (it did, in the clip finder, until 2026-09-20).
  const src = read(UNLOCK_SRC[0]!);
  expect(src, "an unreachable worker is not an answer").toContain('"unreachable"');
  // Design review, 2026-09-21: the status line is written with textContent, so a URL in it is plain text a
  // person on a phone has to retype. The recovery link under the box is the tappable answer.
  for (const m of src.matchAll(/(?:this\.set\(\{[\s\S]{0,80}?|return no\()(["`])([^"`]{20,})\1/g))
    expect(m[2], "a status sentence hands out a URL to retype").not.toMatch(/https?:\/\//);
  // The person who has just paid is told what they bought, in their own tool's words — "five minutes" for two of
  // them and "four hours" for the third, so the sentence is composed from paidLine and never hard-coded.
  expect(src, "the thank-you states what was bought").toContain("Thank you — nothing to paste. ${this.cfg.paidLine} Your key is above.");
  expect(code(src), "a stored key turns the paid version on before the check is made").toMatch(/this\.set\(\{ on: true, key: saved[\s\S]{0,400}?await this\.ask\(saved\)/);
  expect(code(src), "and an unreachable check leaves it on").toMatch(/if \(answer === "unreachable"\) return;/);
});

test("the key box is on the page, never behind a fold-out, and the key is readable once paid", () => {
  for (const t of SHARED) {
    const html = read(`${t.dist}/index.html`);
    // Cold user, 2026-09-19: told the price, then made to hunt for where the key goes. It reached a paying customer.
    const upToKeyrow = html.slice(0, html.indexOf('id="keyrow"'));
    const openDetails = (upToKeyrow.match(/<details/g) ?? []).length - (upToKeyrow.match(/<\/details>/g) ?? []).length;
    expect(openDetails, `${t.name}: the key box is inside a fold-out`).toBe(0);
    expect(html, `${t.name}: the key box exists`).toContain('id="keyrow"');
    expect(html, `${t.name}: somewhere to say how it went`).toContain('id="keystatus"');
    // The key, in full, with a way to copy it: a masked key cannot be carried to a second device.
    expect(html, `${t.name}: the key is shown`).toContain('id="paidkey"');
    expect(html, `${t.name}: and can be copied`).toContain('id="keycopy"');
    expect(code(read(t.app)), `${t.name}: the key is printed whole, not masked`).toContain('$("paidkey").textContent = s.key');
    // Lost it: a way back that is not "search your email". Cold user, 2026-09-21: this link used to live inside
    // #paidpanel, which is hidden from the one person who needs it — someone locked out on a second device.
    expect(html, `${t.name}: a way to get the key again`).toContain('id="keylost"');
    expect(html, `${t.name}: which points at Polar's own portal`).toContain("polar.sh/smaverk/portal");
    // Polar's portal asks for the address the purchase was made with, so the page has to say which email, or
    // someone who paid from a second address stalls there with nothing to go on.
    expect(text(html).replace(/\s+/g, " "), `${t.name}: the recovery line names which email`).toContain("Lost your key? Get it again with the email you paid with.");
    const panel = html.slice(html.indexOf('id="paidpanel"'), html.indexOf("</div>", html.indexOf('id="paidpanel"')));
    expect(panel, `${t.name}: the recovery link is hidden inside the paid panel`).not.toContain('id="keylost"');
    expect(html.indexOf('id="keylost"'), `${t.name}: the recovery link sits with the key box`).toBeGreaterThan(html.indexOf('id="keystatus"'));
    expect(code(read(t.app)), `${t.name}: and it hides once they are paid`).toContain('$("keylostline").hidden = s.on');
    // Removing the key wipes the only copy on screen, so it asks first.
    expect(code(read(t.app)), `${t.name}: removing the key asks first`).toMatch(/removekey[\s\S]{0,200}confirm\(/);
    // Design review, 2026-09-21: as an inline link on a 22 px line it shared its 44 px tap box with the link
    // beside it, and won the hit test — so aiming at recovery destroyed the key. It gets its own row.
    expect(html, `${t.name}: removing the key is a button on its own row, not an inline link`).toMatch(/<p class="keyline"><button class="btn quiet" id="removekey"/);
    // The status sentence says "your key is above", so it has to render after the panel that holds the key.
    expect(html.indexOf('id="keystatus"'), `${t.name}: the status sentence sits below the paid panel`).toBeGreaterThan(html.indexOf('id="paidpanel"'));
    expect(html.indexOf('id="keystatus"'), `${t.name}: and above the box it labels`).toBeLessThan(html.indexOf('id="keyrow"'));
    // A bundle key says what else it opens.
    expect(html, `${t.name}: room to name the other tools a key opens`).toContain('id="keyalso"');
    // The clip finder's state matrix failed on a 40 px Copy button, 2026-09-20. 44 px is the floor everywhere.
    expect(html, `${t.name}: the Copy button meets the 44 px tap target`).toContain(".keyline .btn{width:auto;min-height:44px");
  }
});

test("every page tells the same story about unlocking", () => {
  // What every tool promises about unlocking, in the same words. The answer for a second device lives in the
  // paid panel, which only a buyer sees, so it costs nothing against the page's word budget.
  // What every tool promises about unlocking, in the same words — and the fold-out's summary carries the
  // promise, because a closed fold-out shows only its summary and the next visible thing is the paste field.
  const SAME = ["You come straight back, already unlocked. Nothing to paste.", "After paying: nothing to paste"];
  for (const t of SHARED) {
    const html = read(`${t.dist}/index.html`);
    for (const s of SAME) expect(text(html).replace(/\s+/g, " "), `${t.name}: "${s.slice(0, 40)}…"`).toContain(s);
    // The storage name is the same everywhere, and llms.txt says so.
    expect(read(`${t.dist}/llms.txt`), `${t.name}: llms.txt names the storage`).toContain("`smaverk.key`");
    expect(read(`${t.dist}/llms.txt`), `${t.name}: llms.txt names the entitlement call`).toContain("unlock.smaverk.com/entitlements");
  }
  // A device count nobody enforces is a promise we break. No page states one (no activation is ever consumed).
  for (const p of [...pages(), ...cfPages(), STUDIO, ...LEGAL]) {
    expect(text(read(p)), `${p}: an unenforced device count`).not.toMatch(/\b(one|two|three|four|five|\d+)\s+devices\b/i);
  }
  // Terms and privacy cover every tool that is sold, the clip finder included.
  for (const p of LEGAL) for (const tool of ["Captions", "Vertical", "Clip finder", "Clips"]) expect(read(p), `${p}: covers ${tool}`).toContain(tool);
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

// Terms describes each tool's free and paid versions, and names no price: prices live on each tool's page.
test("terms describes the clip finder's two versions, and names no price", () => {
  const terms = text(read(LEGAL[1]!)).replace(/\s+/g, " ");
  expect(terms).toMatch(/In Clip finder the free version reads recordings up to 30 minutes/);
  expect(terms, "no price in the terms").not.toMatch(/\$\d+/);
  expect(terms, "nothing left from the free-while-new days").not.toMatch(/while it is new/i);
});

// The studio page exists to list the tools. A live tool missing from it is the failure this guards.
test("the studio lists every tool that is live, with its price state", () => {
  const studio = read(STUDIO); const t = text(studio).replace(/\s+/g, " ");
  for (const [name, host] of [["Captions", "captions"], ["Vertical", "vertical"], ["Clip finder", "clipfinder"], ["Clips", "clips"], ["Operator", "operator"]] as const) {
    expect(t, `the studio names ${name}`).toContain(name);
    expect(studio, `${name} links to its own host`).toContain(`https://${host}.smaverk.com/?src=studio`);
  }
  expect((studio.match(/<article class="tool/g) ?? []).length, "one card per tool").toBe(5);
  // Every paid tool says its own price: free to try, then once. Operator is a free preview and says so in words.
  expect(t, "the Operator card says it is free, in words").toContain("Free while it is a preview.");
  expect(t, "the clip finder's card states its price").toContain("$29 once: up to four hours");
  expect(t, "nothing left from the free-while-new days").not.toMatch(/while it is new/i);
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
  for (const f of [/a still of each face/, /camera turns off when you leave the page/, /[Ff]ree while (in|it is a) preview/]) { expect(t, String(f)).toMatch(f); expect(llms, `llms.txt ${f}`).toMatch(f); }
  expect(html, "JSON-LD: free while a preview").toMatch(/"price":"0","priceCurrency":"USD","description":"Free while in preview"/);
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

test("Clips: the price and the cap are each one constant, and the page states the same ones", () => {
  const app = read("clips/app/app.ts"), plan = read("clips/app/src/lib/plan.ts"), html = read("clips/app/dist/index.html");
  expect(app).toContain('export const PRICE = "$49"');
  expect([...new Set(code(app).match(/\$\d+/g) ?? [])], "no second price in the script").toEqual(["$49"]);
  expect(plan, "the cap").toMatch(/export const MAX_CLIP_S = 90;/);
  expect(text(html), "the page states the cap").toMatch(/up to 90 seconds/);
  expect(text(read("clips/app/dist/llms.txt"))).toMatch(/up to 90 seconds/);
  // The clips are the other tools' own code, imported, not copied.
  const make = read("clips/app/src/make.ts");
  for (const m of ["vertical/app/src/detect", "vertical/app/src/fastsave", "vertical/app/src/lib/track", "captions/app/src/draw", "captions/app/src/lib/lines", "clipfinder/app/src/lib/decode"]) expect(make, `make.ts uses ${m}`).toContain(`/${m}"`);
  expect(read("clips/app/finder.ts")).toContain('import "../../clipfinder/app/worker"');
  expect(read("clips/app/listen.ts")).toContain('import "../../captions/app/worker"');
  // The checkout: the production link in the markup (it works before the script runs) and the same one in the script; no placeholder left.
  const buy = html.match(/<a [^>]*id="buy"[^>]*>/)?.[0] ?? "";
  expect(buy, "the buy link goes to the production checkout").toMatch(/href="https:\/\/buy\.polar\.sh\/polar_cl_/);
  expect(code(app), "the script knows the same checkout").toContain(buy.match(/href="([^"]+)"/)![1]!);
  expect(code(app), "no placeholder left").not.toMatch(/"__[A-Z_]+__"/);
  // The studio key: a Clips key opens the three tools it is built from, and the page, llms.txt and the terms say so.
  for (const [f, t] of [["page", text(html)], ["llms.txt", read("clips/app/dist/llms.txt")], ["terms", text(read(LEGAL[1]!))]] as const) expect(t, `${f} says what else the key opens`).toMatch(/also opens (the three tools Clips is built from: )?Captions, Vertical and Clip finder/);
  // LAUNCH.md stays in the private repository (it names the worker and the rail), so this holds only where it is.
  if (existsSync(join(ROOT, "clips/LAUNCH.md"))) expect(read("clips/LAUNCH.md"), "what to create is written down").toMatch(/__LINK__/);
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
    ["the page, in the price box", html.match(/<div class="price"[\s\S]*?<\/div><\/div>/)?.[0] ?? ""],
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
const TOP_PAGES = [STUDIO, "captions/app/dist/index.html", "vertical/app/dist/index.html", "clipfinder/app/dist/index.html", "clips/app/dist/index.html", "operator/app/dist/index.html"].filter((p) => existsSync(join(ROOT, p)));
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
    expect(html, `${p}: brand link`).toMatch(/<div class="top"><a class="brand" href="https:\/\/smaverk\.com"><i><\/i>Småverk/);
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
    expect(html.match(/<div class="top">[\s\S]*?<\/div>/)?.[0], `${p}: brand link and button in the top row`).toMatch(/<a class="brand" href="https:\/\/smaverk\.com"><i><\/i>Småverk[\s\S]*<button class="theme" id="theme"/);
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
  for (const p of [STUDIO, ...LEGAL]) expect(read(p), p).toContain(".top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:");
  for (const p of [STUDIO, ...LEGAL]) expect(read(p), p).toMatch(/\.top\{[^}]*margin-inline:calc\(\(100% - min\(1100px, 100vw - 32px\)\) \/ 2\)/);
  for (const p of TOP_PAGES.slice(1)) expect(read(p), p).toMatch(/\.wrap\{max-width:1100px;/);
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
  expect(items).toEqual(["Works offline once loaded", "Nothing uploaded", "No account", "Pay once, through Polar", "Refund within 14 days", "Clips key opens every paid tool"]);
  for (const i of items) expect(i.split(" ").length, i).toBeLessThanOrEqual(6);
  // The Operator card says what it is now: a full-screen camera, its three commands, and a shape that follows the device.
  const op = text(studio.split("<article").find((a) => /<h3>Operator<\/h3>/.test(a)) ?? "");
  for (const f of [/full-screen camera/, /films each face/, /follows one person/, /whoever talks/, /tall or wide/]) expect(op, String(f)).toMatch(f);
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
  expect(text(studio.split("<article").find((a) => /<h3>Clip finder<\/h3>/.test(a)) ?? "")).toMatch(/Free up to 30 minutes, to watch\./);
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
