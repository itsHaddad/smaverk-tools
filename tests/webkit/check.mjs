// check.mjs: one page, one script that drives it from inside, one browser engine, and what came out measured.
//
//   node tests/webkit/check.mjs --serve clips/app/dist --driver clips/app/tests/e2e/webkit-make.js \
//        --fixture out/fixtures/talk.mp4 --engine webkit [--device "iPhone 15"] --out out/webkit [--minutes 45]
//
//   --serve <dir>     serve a built page (headers from its Cloudflare `_headers` file, byte ranges for video)
//   --url <url>       or proxy a live page instead, so it is tested as deployed
//   --driver <file>   a script injected at the top of every HTML page; it drives the page with window.__check
//                   (repeatable: the files run in order, so a shim can go before the driver)
//   --fixture <file>  a file the driver can fetch as __check.fixture(<basename>) (repeatable)
//   --param k=v       a value the driver reads as __check.params.k (repeatable)
//   --engine          webkit | chromium (Playwright), or simulator (Mobile Safari in the booted iOS Simulator)
//   --device <name>   a Playwright device profile, e.g. "iPhone 15" (the page then sees an iPhone's agent and screen)
//   --ignore <regex>  page errors matching this are kept in the report but do not fail the run
//
// Why a driver inside the page instead of Playwright calls: the iOS Simulator's Safari cannot be driven by Playwright,
// and WebDriver on it needs a setting switched on by hand. A script the server injects runs the same in every engine,
// so one driver covers Playwright WebKit on Linux, an iPhone profile, and the real Mobile Safari on a Mac. It is also
// how a camera page is tested: the driver can replace navigator.mediaDevices.getUserMedia before the page's own
// scripts run (see camera-shim.js).
//
// Memory is measured from outside, once a second, as resident size per browser process: WebKit gives a page no heap
// figure (performance.memory is Chromium's), and on an iPhone the tab is killed on its web content process's size,
// which is the number reported as `peakWebProcessMB`.
//
// The driver's report and any file it hands back (__check.put) land in --out; each .mp4 is read with ffprobe when
// ffprobe is on the machine. Exit 0 only when the driver called __check.done and no unignored page error happened.
import http from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const one = (n, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const many = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const serveDir = one("serve") && resolve(one("serve"));
const upstream = one("url");
const driverPaths = many("driver");
const engine = one("engine", "webkit");
const device = one("device");
const out = resolve(one("out", "out/webkit"));
const minutes = Number(one("minutes", "45"));
const ignore = one("ignore") ? new RegExp(one("ignore")) : null;
const fixtures = Object.fromEntries(many("fixture").map((f) => [basename(f), resolve(f)]));
const params = Object.fromEntries(many("param").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
if ((!serveDir && !upstream) || !driverPaths.length || !["webkit", "chromium", "simulator"].includes(engine)) {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 17).join("\n"));
  process.exit(2);
}
for (const f of Object.values(fixtures)) if (!existsSync(f)) { console.error(`no such fixture: ${f}`); process.exit(2); }
mkdirSync(out, { recursive: true });
const label = engine === "simulator" ? "simulator" : `${engine}${device ? ` (${device})` : ""}`;
const log = (m) => console.log(`${String(Math.round(performance.now() / 1000)).padStart(5)}s  ${m}`);

// ---- the in-page side ----------------------------------------------------------------------------------------------
// Loaded before anything of the page's own. It catches errors, and gives the driver fixtures, a log, a file drop and a
// finish line, all over plain HTTP to this server, because the simulator gives no other way back.
const runtime = `(() => {
  if (window.__check) return;
  const t0 = performance.now(), errors = [];
  const post = (path, body, type) => fetch(path, { method: "POST", body, headers: { "content-type": type || "application/json" } });
  addEventListener("error", (e) => errors.push("error: " + e.message + (e.filename ? " @ " + e.filename.split("/").pop() + ":" + e.lineno : "")));
  addEventListener("unhandledrejection", (e) => errors.push("rejection: " + String((e.reason && e.reason.message) || e.reason)));
  const ce = console.error.bind(console);
  console.error = (...a) => { errors.push("console: " + a.map(String).join(" ").slice(0, 300)); ce(...a); };
  let peakHeap = 0;
  setInterval(() => { const h = performance.memory && performance.memory.usedJSHeapSize; if (h > peakHeap) peakHeap = h; }, 1000);
  const report = (extra) => ({ ...extra, errors, peakHeapBytes: peakHeap || null, pageMs: Math.round(performance.now() - t0), ua: navigator.userAgent, crossOriginIsolated: !!self.crossOriginIsolated, screen: [screen.width, screen.height, devicePixelRatio] });
  let finished = false;
  window.__check = {
    params: ${JSON.stringify(params)},
    fixtures: ${JSON.stringify(Object.keys(fixtures))},
    log: (msg) => post("/__check/log", JSON.stringify({ msg: String(msg) })).catch(() => {}),
    fixtureUrl: (name) => "/__check/fixture/" + encodeURIComponent(name),
    fixture: async (name, type) => {
      const r = await fetch("/__check/fixture/" + encodeURIComponent(name));
      if (!r.ok) throw new Error("fixture " + name + ": HTTP " + r.status);
      return new File([await r.blob()], name, { type: type || r.headers.get("content-type") || "" });
    },
    put: async (name, blob) => { const r = await post("/__check/file/" + encodeURIComponent(name), blob, "application/octet-stream"); if (!r.ok) throw new Error("put " + name + ": HTTP " + r.status); },
    waitFor: async (fn, ms, what) => {
      const end = performance.now() + ms;
      for (;;) { let v; try { v = fn(); } catch { v = false; } if (v) return v; if (performance.now() > end) throw new Error((what || "a condition") + " did not happen in " + Math.round(ms / 1000) + " s"); await new Promise((r) => setTimeout(r, 500)); }
    },
    done: (result) => { if (finished) return; finished = true; return post("/__check/done", JSON.stringify(report({ ok: true, result }))); },
    fail: (err, result) => { if (finished) return; finished = true; return post("/__check/done", JSON.stringify(report({ ok: false, error: String((err && err.stack) || err), result }))); },
  };
})();`;
const driver = driverPaths.map((f) => `// ---- ${basename(f)}\n${readFileSync(f, "utf8")}`).join("\n");
const inject = (html) => {
  const tags = `<script src="/__check/runtime.js"></script><script src="/__check/driver.js"></script>`;
  return /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + tags) : tags + html;
};

// ---- the server ------------------------------------------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain", ".xml": "application/xml", ".tflite": "application/octet-stream", ".onnx": "application/octet-stream", ".bin": "application/octet-stream" };
/** Cloudflare Pages `_headers`: a path line, then indented "Name: value" lines. Exact paths and a trailing * only. */
function headerRules(dir) {
  const f = join(dir, "_headers"), rules = [];
  if (!existsSync(f)) return rules;
  let cur = null;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { cur = { path: line.trim(), headers: {} }; rules.push(cur); continue; }
    const i = line.indexOf(":");
    if (cur && i > 0) cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}
const rules = serveDir ? headerRules(serveDir) : [];
const headersFor = (p) => Object.assign({}, ...rules.filter((r) => (r.path.endsWith("*") ? p.startsWith(r.path.slice(0, -1)) : p === r.path)).map((r) => r.headers));

function sendFile(req, res, file, headers) {
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  if (type.startsWith("text/html")) {
    const body = Buffer.from(inject(readFileSync(file, "utf8")));
    res.writeHead(200, { ...headers, "content-type": type, "content-length": body.length, "cache-control": "no-store" });
    return res.end(body);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m) { // Safari will not play a video from a server that cannot answer a byte range
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

async function proxy(req, res, path) {
  const hop = new Set(["host", "connection", "accept-encoding", "content-length", "transfer-encoding"]);
  const fwd = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !hop.has(k)));
  const r = await fetch(new URL(path, upstream), { headers: fwd, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  const headers = {};
  r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v; });
  if ((r.headers.get("content-type") ?? "").includes("text/html")) {
    const body = Buffer.from(inject(await r.text()));
    res.writeHead(r.status, { ...headers, "content-length": body.length, "cache-control": "no-store" });
    return res.end(body);
  }
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { ...headers, "content-length": body.length });
  res.end(body);
}

const readBody = (req) => new Promise((ok, no) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => ok(Buffer.concat(parts))); req.on("error", no); });
let finish;
const finished = new Promise((r) => (finish = r));
const files = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === "/__check/runtime.js") { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); return res.end(runtime); }
    if (p === "/__check/driver.js") { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }); return res.end(driver); }
    if (p.startsWith("/__check/fixture/")) {
      const f = fixtures[p.slice("/__check/fixture/".length)];
      if (!f) { res.writeHead(404); return res.end("no such fixture"); }
      return sendFile(req, res, f, { "cross-origin-resource-policy": "same-origin" });
    }
    if (req.method === "POST" && p === "/__check/log") { log(`page: ${JSON.parse(await readBody(req)).msg}`); res.writeHead(204); return res.end(); }
    if (req.method === "POST" && p.startsWith("/__check/file/")) {
      const name = basename(p.slice("/__check/file/".length));
      const body = await readBody(req);
      writeFileSync(join(out, name), body);
      files.push(name);
      log(`page handed back ${name}, ${(body.length / 1e6).toFixed(1)} MB`);
      res.writeHead(204); return res.end();
    }
    if (req.method === "POST" && p === "/__check/done") { finish(JSON.parse(await readBody(req))); res.writeHead(204); return res.end(); }
    if (upstream) return await proxy(req, res, url.pathname + url.search);
    let rel = p === "/" ? "/index.html" : p;
    if (!extname(rel) && existsSync(join(serveDir, `${rel}.html`))) rel += ".html";
    const file = join(serveDir, rel);
    if (!file.startsWith(serveDir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    sendFile(req, res, file, headersFor(p));
  } catch (e) {
    log(`server: ${req.method} ${p}: ${e?.message ?? e}`);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://localhost:${server.address().port}/`;
log(`serving ${upstream || serveDir} at ${pageUrl}, driver ${driverPaths.join(" + ")}, fixtures ${Object.keys(fixtures).join(", ") || "none"}`);

// ---- memory, from outside ---------------------------------------------------------------------------------------------
const WEB = /WebKitWebProcess|com\.apple\.WebKit\.WebContent|--type=renderer/;
const ANY = /WebKit|MobileSafari|ms-playwright|chrom(e|ium)|headless_shell/;
const mem = { peakWebProcessMB: 0, peakTotalMB: 0, samples: [] };
const memTimer = setInterval(() => {
  try {
    const rows = execFileSync("ps", ["-axo", "rss=,args="], { maxBuffer: 16 << 20 }).toString().split("\n").map((l) => l.trim()).filter((l) => ANY.test(l) && !/\bps -axo\b|check\.mjs/.test(l));
    const kb = rows.map((l) => [Number(l.split(/\s+/)[0]), l]);
    const web = Math.max(0, ...kb.filter(([, l]) => WEB.test(l)).map(([n]) => n)) / 1024;
    const total = kb.reduce((a, [n]) => a + n, 0) / 1024;
    mem.peakWebProcessMB = Math.max(mem.peakWebProcessMB, web);
    mem.peakTotalMB = Math.max(mem.peakTotalMB, total);
    mem.samples.push([Math.round(performance.now() / 1000), Math.round(web), Math.round(total)]);
  } catch { /* one missed second; the next samples again */ }
}, 1000);

// ---- the engine ---------------------------------------------------------------------------------------------------------
let browser, udid;
const pageErrors = [];
const deadline = new Promise((r) => setTimeout(() => r({ ok: false, error: `the driver did not finish in ${minutes} min` }), minutes * 60_000));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 16 << 20 });
try {
  if (engine === "simulator") {
    const devices = Object.entries(JSON.parse(sh("xcrun", ["simctl", "list", "devices", "available", "-j"])).devices)
      .filter(([rt]) => /iOS/.test(rt)).flatMap(([rt, ds]) => ds.map((d) => ({ ...d, rt })));
    const booted = devices.find((d) => d.state === "Booted");
    const want = device || "iPhone";
    const pick = booted ?? devices.filter((d) => d.name.startsWith(want)).sort((a, b) => b.rt.localeCompare(a.rt, undefined, { numeric: true }))[0];
    if (!pick) throw new Error(`no ${want} simulator here: ${devices.map((d) => d.name).join(", ")}`);
    udid = pick.udid;
    log(`simulator: ${pick.name}, ${pick.rt.split(".").pop()}`);
    if (!booted) spawnSync("xcrun", ["simctl", "boot", udid], { stdio: "inherit" });
    const bs = spawnSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { encoding: "utf8", timeout: 600_000 });
    if (bs.status !== 0) throw new Error(`the simulator did not boot: ${bs.stderr || bs.stdout}`);
    sh("xcrun", ["simctl", "openurl", udid, pageUrl]);
    log("opened in Mobile Safari");
  } else {
    const pw = await import("playwright");
    if (device && !pw.devices[device]) throw new Error(`no Playwright device named "${device}"`);
    browser = await pw[engine].launch(engine === "chromium" ? { args: ["--no-sandbox"] } : {});
    const ctx = await browser.newContext(device ? pw.devices[device] : { viewport: { width: 1280, height: 900 } });
    await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on("crash", () => { pageErrors.push("the page crashed"); finish({ ok: false, error: "the page crashed (the web process died)" }); });
    await page.goto(pageUrl, { waitUntil: "load", timeout: 120_000 });
    log(`opened in ${label} ${browser.version()}`);
  }
} catch (e) {
  finish({ ok: false, error: `could not open the page: ${e?.stack ?? e}` });
}

const t0 = performance.now();
const report = await Promise.race([finished, deadline]);
const wallS = Math.round((performance.now() - t0) / 100) / 10;
clearInterval(memTimer);
if (engine === "simulator" && udid) spawnSync("xcrun", ["simctl", "io", udid, "screenshot", join(out, "screen.png")]);
await browser?.close().catch(() => {});
server.close();

// ---- what came out --------------------------------------------------------------------------------------------------------
const probed = {};
const hasProbe = spawnSync("ffprobe", ["-version"]).status === 0;
for (const f of files.filter((n) => /\.(mp4|mov|webm)$/i.test(n))) {
  if (!hasProbe) break;
  const p = JSON.parse(sh("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,sample_rate:format=duration,size", "-of", "json", join(out, f)]));
  const v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
  probed[f] = { width: v?.width ?? null, height: v?.height ?? null, video: v?.codec_name ?? null, audio: a ? `${a.codec_name} ${a.sample_rate} Hz` : null, seconds: Number(p.format.duration), bytes: Number(p.format.size) };
}
const errors = [...(report.errors ?? []), ...pageErrors];
const blocking = errors.filter((e) => !ignore?.test(e));
const summary = {
  engine: label, ok: !!report.ok && blocking.length === 0, error: report.error ?? null, wallS,
  memory: { peakWebProcessMB: Math.round(mem.peakWebProcessMB), peakTotalMB: Math.round(mem.peakTotalMB), peakHeapMB: report.peakHeapBytes ? Math.round(report.peakHeapBytes / 1048576) : null },
  ua: report.ua ?? null, crossOriginIsolated: report.crossOriginIsolated ?? null, screen: report.screen ?? null,
  result: report.result ?? null, files: probed, errors, blockingErrors: blocking,
};
writeFileSync(join(out, "report.json"), JSON.stringify({ ...summary, memSamples: mem.samples }, null, 1));
log(`${summary.ok ? "OK" : "FAIL"} ${label} in ${wallS} s; peak web process ${summary.memory.peakWebProcessMB} MB, all browser processes ${summary.memory.peakTotalMB} MB${summary.memory.peakHeapMB ? `, JS heap ${summary.memory.peakHeapMB} MB` : ", no JS heap figure from this engine"}`);
if (report.error) log(`error: ${report.error}`);
for (const e of blocking.slice(0, 10)) log(`page error: ${e}`);
for (const [f, p] of Object.entries(probed)) log(`${f}: ${p.width}x${p.height} ${p.video}, ${p.audio ?? "no sound"}, ${p.seconds.toFixed(2)} s`);
process.exit(summary.ok ? 0 : 1);
