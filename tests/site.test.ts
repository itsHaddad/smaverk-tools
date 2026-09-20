// site.test.ts: the ripple check. When one thing changes, the other places that state the same fact must change with it
// (the principal, 2026-09-18: a studio page whose Privacy link opened another tool's policy, a terms page still describing
// a feature as unfinished, "never" promises). No browser: runs in `bun test tests/` locally, in deploy.sh and on the runner.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// A tool joins this list the day it gets a page, and every check below then applies to it. `prices` empty
// means it costs nothing today: the checks flip from "the price agrees everywhere" to "no price anywhere",
// because a number in front of a visitor that the owner has not given is the worse failure of the two.
// `limits` are the sentences that must appear wherever a searcher can land, since a limit discovered after
// the work is done is what earns one-star reviews. `copy` is where the page's own sentences live.
const SITES = {
  captions: { dist: "captions/app/dist", src: ["captions/app/app.ts", "captions/app/worker.ts"], prices: ["$19"], limits: ["60 seconds", "five minutes"], page: "index.html", host: "captions.smaverk.com", copy: "captions/app/app.ts", savedPrice: true },
  vertical: { dist: "vertical/app/dist", src: ["vertical/app/app.ts", "vertical/app/src/detect.ts", "vertical/app/src/fastsave.ts"], prices: ["$24", "$29"], limits: ["60 seconds", "five minutes"], page: "index.html", host: "vertical.smaverk.com", copy: "vertical/app/app.ts", savedPrice: true },
  clipfinder: { dist: "clipfinder/app/dist", src: ["clipfinder/app/app.ts", "clipfinder/app/worker.ts"], prices: [], limits: ["four hours"], page: "index.html", host: "clipfinder.smaverk.com", copy: "clipfinder/app/src/lib/pricing.ts", savedPrice: false },
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

test("Privacy and Terms links open the studio's own pages, from every page", () => {
  const bad: string[] = [];
  for (const p of pages()) for (const m of read(p).matchAll(/href="([^"]*\b(privacy|terms)\b[^"]*)"/g)) if (!/^https:\/\/smaverk\.com\/(privacy|terms)$/.test(m[1]!)) bad.push(`${p}: ${m[1]}`);
  expect(bad).toEqual([]);
  for (const l of LEGAL) { const h = read(l); expect(h).toContain(`<link rel="canonical" href="https://smaverk.com/`); for (const tool of ["Captions", "Vertical"]) expect(h).toContain(tool); }
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
  const KNOWN: Record<string, RegExp> = { "api.polar.sh": /Polar/, "sandbox-api.polar.sh": /Polar/, "buy.polar.sh": /Polar/, "unlock.smaverk.com": /small service of ours/, "captions.smaverk.com": /./, "vertical.smaverk.com": /./, "smaverk.com": /./ };
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
      expect(studio, `studio card for ${name} says what it costs`).toMatch(/Free while it is new/);
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
  for (const l of LEGAL) for (const tool of ["Captions", "Vertical", "Clip finder"]) expect(text(read(l)), `${l} names ${tool}`).toContain(tool);
});

test("each sitemap lists only pages on its own host", () => {
  const check = (file: string, host: string) => { for (const m of read(file).matchAll(/<loc>https:\/\/([^/<]+)/g)) expect(`${file}: ${m[1]}`).toBe(`${file}: ${host}`); };
  check("captions/app/dist/sitemap.xml", "captions.smaverk.com"); check("captions/app/dist/studio-sitemap.xml", "smaverk.com"); check("clipfinder/app/dist/sitemap.xml", "clipfinder.smaverk.com");
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
    expect(html, `${name}: Saved box states the price with a link to the checkout`).toMatch(new RegExp(`<span id="rmark">[^<]*<a id="rbuy" href="https://[^"]+"[^>]*>${price} once</a>[^<]*five minutes[^<]*</span>`));
    expect(code(read(s.src[0]!)), `${name}: both buy links get the checkout address`).toMatch(/\["buy", "rbuy"\]/);
    // Cold user, 2026-09-19: the checkout opened in the same tab and Back wiped the clip. Both links open their own tab; the first tab picks the key up.
    expect(html.match(/<a [^>]*id="r?buy"[^>]*>/g)!.every((a) => /target="_blank" rel="noopener"/.test(a)), `${name}: buy links open their own tab`).toBe(true);
    // Design review 6, 2026-09-19: on every desktop the 440 px column broke the price in two ("$24" / "once") and its tap area lay over "Save again".
    expect(html, `${name}: the price in the Saved box stays in one piece`).toContain("#rbuy{white-space:nowrap}");
    expect(code(read(s.src[0]!)), `${name}: the first tab picks up the key`).toMatch(/addEventListener\("storage"/);
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
  expect(text(studio.match(/<h1>[\s\S]*?<\/h1>/)![0]).replace(/\s+/g, " ").trim()).toBe("Small AI tools that run on your device.");
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

test("Captions: the defaults keep the words off the speaker's face and the main button on the first screen", () => {
  // Design review 2, 2026-09-19: Big sat at the middle of the frame, over the speaker's mouth (band 0.44 to 0.55 of the height, face 0.19 to 0.47);
  // on a 1440 x 900 screen the stage took 78% of the height and the button sat below the fold (Qa.ts now fails on that too).
  const app = read("captions/app/app.ts"); const at = app.match(/st === "big" \? ([\d.]+) : st === "bar" \? ([\d.]+) : ([\d.]+)/)!;
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
  for (const p of ["captions/app/dist/index.html", "captions/app/dist/studio.html", "vertical/app/dist/index.html", "clipfinder/app/dist/index.html"]) { const h = read(p); expect(h, `${p}: Search Console tag`).toMatch(/<meta name="google-site-verification" content="[\w-]{20,}">/); expect(h, `${p}: canonical`).toMatch(/<link rel="canonical" href="https:\/\/[a-z.]*smaverk\.com\/">/); expect(h, `${p}: description`).toMatch(/<meta name="description" content="[^"]{60,}">/); }
  for (const d of ["captions/app/dist", "vertical/app/dist", "clipfinder/app/dist"]) { const key = readdirSync(join(ROOT, d)).find((f) => /^[0-9a-f]{32}\.txt$/.test(f)); expect(key, `${d}: IndexNow key file`).toBeTruthy(); expect(read(`${d}/${key}`).trim()).toBe(key!.slice(0, 32)); }
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
  const trust = html.match(/<p class="trust" id="trust">([^<]*)<\/p>/)?.[1];
  expect(trust, "trust line").toBeTruthy();
  expect(code(read("clipfinder/app/src/lib/pricing.ts")), "the script writes the page's sentence").toContain(`trust: "${trust}"`);
});

test("Clip finder: it is free, it says so, and no price reaches a visitor", () => {
  // The owner, 2026-09-20: "about the money, we can make it available as trial in the beginning or
  // something like that." So nothing a visitor reads names a number — and the guard stays, because the
  // day a number arrives it must be HIS number and only in the one place it is allowed to be.
  const priced: string[] = [];
  for (const f of ["index.html", "llms.txt"]) for (const m of text(read(`${CF.dist}/${f}`)).replace(/\$\d+ a month/g, " ").matchAll(/\$\d+/g)) priced.push(`${f}: ${m[0]}`);
  expect(priced, "a price on something a visitor reads").toEqual([]);
  // Where a price may still be written — the constant, and the sentences that are asleep with it — it is
  // the one number and nothing else.
  expect(read(CF.src[0]!), "the price is a single named constant in the script").toContain(`export const PRICE = "${CF.price}"`);
  expect([...new Set(code(read(CF.src[0]!)).match(/\$\d+/g) ?? [])], "no second price anywhere in the script").toEqual([CF.price]);
  expect(code(read("clipfinder/app/src/lib/pricing.ts")).match(/\$\d+/g) ?? [], "the paid sentences are written from the constant, not around it").toEqual([]);
  // Free means the whole tool: the rail is off for everyone the page is served to, and only a rail
  // nobody reaches by accident turns it back on.
  expect(code(read(CF.src[0]!)), "the trial is what a visitor gets").toMatch(/const TRIAL = !SANDBOX;/);
  // Hidden limits earn one-star reviews, so the limit in force is on the page, in llms.txt, and in the
  // script that enforces it. Both limits stay in the script: one is in force, the other is asleep.
  for (const f of ["index.html", "llms.txt"]) expect(text(read(`${CF.dist}/${f}`)), `${f}: the limit in force`).toMatch(/four hours/);
  const app = read(CF.src[0]!);
  expect(app, "the free limit in the script").toMatch(/FREE_S = 30 \* 60/);
  expect(app, "the paid limit in the script").toMatch(/PAID_S = 4 \* 3600/);
  // What it costs is in the header, on the first screen, and its target exists.
  expect(read(`${CF.dist}/index.html`).match(/<div class="top">[\s\S]*?<\/div>/)?.[0], "header tag").toMatch(/<a class="tag" id="tag" href="#price"><b>Free while it is new<\/b><\/a>/);
  expect(read(`${CF.dist}/index.html`), "the tag's target").toContain('<div class="price" id="price">');
  expect(read(`${CF.dist}/index.html`).match(/<a [^>]*id="buy"[^>]*>/g)!.every((a) => /target="_blank" rel="noopener"/.test(a)), "the buy link opens its own tab").toBe(true);
  // The checkout button and the box a key goes in are in the markup and hidden: asleep, not deleted.
  for (const id of ["buy", "afterpay"]) expect(read(`${CF.dist}/index.html`).match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`))?.[0], `${id} is hidden while the tool is free`).toMatch(/\shidden(\s|>)/);
  expect(code(read(CF.src[0]!)), "the first tab picks up the key").toMatch(/addEventListener\("storage"/);
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
  const url = sources.match(/https:\/\/www\.nasa\.gov\/[\w/-]+/)?.[0];
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
