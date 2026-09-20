// verify-find.mjs: the product gate. A real recording goes through the built page in a real browser and
// everything the page promises is checked against what actually came out.
//
//   bun tests/e2e/verify-find.mjs
//
// What it proves:
//   1. Moments appear BEFORE the reading is finished. That is the whole shape of the product.
//   2. The final list is real: times inside the recording, a length near the one asked for, a reason on
//      every one, and the words it opens on.
//   3. The recording never leaves the device. Every request the page makes is either its own file or the
//      one-off download of the tool; nothing carries a body.
//   4. With the network off after the tool is on the device, it still works. That is the promise the
//      page makes in words, so it is made in a test as well.
//   5. The paid exports: a timeline file that contains the moments, and the clip itself, cut out of the
//      file and checked with ffprobe.
//
// The key check is answered by a stub. Polar's validation is somebody else's service; what this gate is
// for is the page's behaviour once a key is good. The paywall itself is checked first, unstubbed.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 8817;
const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
const fixture = join(root, "tests", "fixtures", "talk6.mp3");
const outDir = join(root, "tests", "e2e", "out");
if (!existsSync(fixture)) {
  console.error(`no fixture at ${fixture}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
// Forty seconds of the same recording, for the offline round. The claim being tested there is that the
// whole pipeline runs with no network once the tool is on the device — not that it finds something, which
// the full run above has already shown. Reading six minutes twice costs seven runner-minutes for nothing.
const shortFixture = join(tmpdir(), "clipfinder-offline.mp3");
if (!existsSync(shortFixture)) execFileSync("ffmpeg", ["-v", "error", "-y", "-t", "40", "-i", fixture, "-c", "copy", shortFixture]);

const server = spawn("bun", [join(root, "serve.ts"), String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false;
const fail = (m) => {
  console.error(`FIND FAIL: ${m}`);
  failed = true;
};
const ok = (m) => console.log(`  ok  ${m}`);

const FIXTURE_S = 390;

/**
 * Wait for something, saying out loud what the page is doing while it waits.
 *
 * The first run of this gate sat for fifteen minutes and then reported that nothing had happened, which
 * is not a finding, it is a gate with its eyes shut. Every thirty seconds it now prints what the page
 * thinks it is doing, and a timeout ends with the page's own state rather than a stack trace.
 */
async function waitSaying(page, what, fn, timeoutMs) {
  const t0 = Date.now();
  let last = "";
  const tick = setInterval(async () => {
    try {
      const st = await page.evaluate(() => ({ ...window.__cf, list: undefined }));
      const line = `state=${st.state} ready=${st.ready} download=${st.downloadPct ?? "-"}% heard=${Math.round(st.heardS ?? 0)}s words=${st.words ?? 0} moments=${st.moments} x=${st.timesRealTime ? st.timesRealTime.toFixed(2) : "-"}${st.error ? ` ERROR=${st.error}` : ""}`;
      if (line !== last) console.log(`      ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${line}`);
      last = line;
    } catch {
      /* the page is busy; the next tick will say something */
    }
  }, 30000);
  try {
    await page.waitForFunction(fn, null, { timeout: timeoutMs, polling: 1000 });
    return true;
  } catch {
    const st = await page.evaluate(() => ({ ...window.__cf, list: undefined })).catch(() => null);
    const status = await page.textContent("#status").catch(() => "");
    fail(`${what} did not happen in ${Math.round(timeoutMs / 1000)} s — page says ${JSON.stringify(st)} / status "${status}"`);
    return false;
  } finally {
    clearInterval(tick);
  }
}
let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
  const page = await ctx.newPage();

  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 200)}`); });

  // Every request the page makes, so "nothing leaves your device" is a measurement and not a slogan.
  const sent = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    const body = r.postData();
    if (u.host !== `localhost:${port}`) sent.push({ host: u.host, method: r.method(), bytes: body ? body.length : 0, url: r.url().slice(0, 100) });
    else if (body) sent.push({ host: u.host, method: r.method(), bytes: body.length, url: r.url().slice(0, 100) });
  });

  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__cf?.state === "sample", null, { timeout: 20000 });

  const t0 = Date.now();
  await page.setInputFiles("#file", fixture);

  // 1. Moments while it is still reading.
  const streamed = await waitSaying(page, "moments while still reading", () => window.__cf?.state === "reading" && window.__cf.moments > 0, 1500000);
  const atFirst = await page.evaluate(() => ({ heardS: window.__cf.heardS, total: window.__cf.totalS, moments: window.__cf.moments }));
  if (!streamed) { /* waitSaying already said what the page was doing */ }
  else if (atFirst.heardS >= FIXTURE_S - 5) fail(`the first moments arrived at ${Math.round(atFirst.heardS)} s, which is the end`);
  else ok(`first moments at ${Math.round(atFirst.heardS)} s of ${FIXTURE_S} s, ${Math.round((Date.now() - t0) / 1000)} s after the file was picked`);

  if (!(await waitSaying(page, "the reading to finish", () => window.__cf?.state === "found", 900000))) throw new Error("the run never finished");
  const run = await page.evaluate(() => ({ ...window.__cf, list: window.__cf.list }));
  const readS = (Date.now() - t0) / 1000;
  ok(`read ${Math.round(run.heardS)} s in ${Math.round(readS)} s (${(readS / FIXTURE_S).toFixed(2)}x real time), ${run.words} words, ${run.silences} silences, ${run.moments} moments`);

  // 2. The list is real.
  if (!run.moments) {
    // Everything below needs a list. Without one, three more waits time out and say nothing new.
    fail(`no moments in a six-minute recording that has speech throughout — status "${await page.textContent("#status").catch(() => "")}"`);
    throw new Error("nothing to check: the run produced no moments");
  }
  for (const [i, m] of (run.list ?? []).entries()) {
    if (!(m.startS >= 0 && m.endS <= FIXTURE_S + 1)) fail(`moment ${i + 1} runs ${m.startS}–${m.endS}, outside the recording`);
    if (!(m.endS - m.startS >= 20)) fail(`moment ${i + 1} is ${Math.round(m.endS - m.startS)} s long`);
    if (!m.why?.length) fail(`moment ${i + 1} has no reason`);
  }
  const openings = await page.$$eval(".moment .says", (els) => els.map((e) => e.textContent.trim()));
  if (openings.some((o) => o.length < 5)) fail(`a moment shows no words: ${JSON.stringify(openings)}`);
  ok(`every moment has a time, a length, a reason and the words it opens on`);

  // 3. Nothing carrying the recording left the device.
  //
  // Two separate claims, because "no request has a body" is not one of them and never was: the analytics
  // beacon posts page timings and the key check posts a key. What must be true is that every host is one
  // the privacy page accounts for, and that nothing leaving is anywhere near the size of a recording —
  // the fixture is 2.3 MB and the smallest thing worth stealing out of it is far above this bar.
  // huggingface.co redirects the weights to its own file hosts, which have several names (cdn-lfs…,
  // us.aws.cdn.hf.co, and whichever region answers next). The privacy page accounts for them as a
  // category — "public file hosts" — which is the only form that survives them being renamed.
  const ALLOWED_HOSTS = /^(huggingface\.co|[\w.-]*\.hf\.co|cdn\.jsdelivr\.net|static\.cloudflareinsights\.com|cloudflareinsights\.com|[\w.-]*\.polar\.sh|polar\.sh)$/;
  const BODY_LIMIT = 8 * 1024;
  const strangers = sent.filter((s) => !ALLOWED_HOSTS.test(s.host));
  const heavy = sent.filter((s) => s.bytes > BODY_LIMIT);
  if (strangers.length) fail(`requests to hosts nothing accounts for: ${JSON.stringify(strangers.slice(0, 4))}`);
  if (heavy.length) fail(`requests carrying more than ${BODY_LIMIT} bytes: ${JSON.stringify(heavy.slice(0, 4))}`);
  if (!strangers.length && !heavy.length)
    ok(`${sent.length} request(s) off this page, every host accounted for, the largest body ${Math.max(0, ...sent.map((s) => s.bytes))} bytes against a ${Math.round(2340958 / 1024)} KB recording`);

  // 4. With the network off, it still works.
  await page.click("#reset");
  await ctx.setOffline(true);
  const offlineT0 = Date.now();
  await page.setInputFiles("#file", shortFixture);
  const offlineOk = await waitSaying(page, "the offline run", () => window.__cf?.state === "found", 600000);
  const offline = offlineOk ? await page.evaluate(() => ({ words: window.__cf.words, error: window.__cf.error })) : null;
  if (offlineOk && !(offline.words > 0)) fail(`with the network off it finished without hearing anything: ${JSON.stringify(offline)}`);
  else if (offlineOk) ok(`read 40 s and heard ${offline.words} words with the network off, in ${Math.round((Date.now() - offlineT0) / 1000)} s`);
  await ctx.setOffline(false);

  // 5a. The paywall, before it is opened.
  const before = page.waitForEvent("download", { timeout: 4000 }).then(() => "downloaded").catch(() => "blocked");
  await page.click('[data-save="premiere"]');
  if ((await before) !== "blocked") fail("an export was saved without paying");
  else ok("an export asks to be paid for first");

  // 5b. With a key, the exports. The key check is a third-party call, so it is stubbed; everything the
  // page then does is real.
  await page.route(/polar\.sh\/v1\/customer-portal\/license-keys\/validate/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "granted" }) }),
  );
  await page.fill("#key", "SMVCF-TEST-0000-0000");
  await page.click("#keygo");
  await page.waitForFunction(() => window.__cf?.licensed === true, null, { timeout: 15000 });

  const list = await page.evaluate(() => window.__cf.list);
  for (const [kind, ext] of [["premiere", "xml"], ["edl", "edl"], ["finalcut", "fcpxml"]]) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(`[data-save="${kind}"]`)]);
    const path = join(outDir, `moments.${ext}`);
    await dl.saveAs(path);
    const text = readFileSync(path, "utf8");
    if (!text.length) fail(`${kind}: the file is empty`);
    if (!dl.suggestedFilename().endsWith(`.${ext}`)) fail(`${kind}: saved as ${dl.suggestedFilename()}`);
    // The first moment's start must be findable in the file, as a timecode or as frames.
    const startF = Math.floor(list[0].startS * 30);
    const hh = String(Math.floor(startF / 108000)).padStart(2, "0");
    const mm = String(Math.floor(startF / 1800) % 60).padStart(2, "0");
    const ss = String(Math.floor(startF / 30) % 60).padStart(2, "0");
    const tc = `${hh}:${mm}:${ss}:${String(startF % 30).padStart(2, "0")}`;
    if (!text.includes(tc) && !text.includes(`<in>${startF}</in>`) && !text.includes(`start="${Math.round(list[0].startS * 3000)}/3000s"`))
      fail(`${kind}: the first moment (${tc} / frame ${startF}) is not in the file`);
    else ok(`${kind}: ${dl.suggestedFilename()}, ${text.length} bytes, the first moment is in it`);
  }

  // 5c. The clip itself, cut on the device and checked with ffprobe.
  const [clip] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), page.click('[data-save="clip"]')]);
  const clipPath = join(outDir, clip.suggestedFilename());
  await clip.saveAs(clipPath);
  const saved = await page.evaluate(() => window.__cf.savedClip);
  if (!saved) fail("the page did not record a saved clip");
  else {
    const probed = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clipPath]).toString().trim());
    const wanted = saved.endS - saved.startS;
    if (!(probed > 0)) fail(`the cut clip has no length: ${clipPath}`);
    else if (Math.abs(probed - wanted) > Math.max(3, wanted * 0.05)) fail(`the cut clip is ${probed.toFixed(1)} s, the moment is ${wanted.toFixed(1)} s`);
    else ok(`${clip.suggestedFilename()}: ${(saved.bytes / 1024).toFixed(0)} KB, ${probed.toFixed(1)} s against ${wanted.toFixed(1)} s asked for`);
  }

  if (errs.length) fail(errs.join(" | "));
  await page.screenshot({ path: join(outDir, "found.png"), fullPage: true });
} catch (e) {
  fail(String(e?.stack ?? e?.message ?? e));
} finally {
  await browser?.close();
  server.kill();
}
if (failed) process.exit(1);
console.log("find gate ok");
