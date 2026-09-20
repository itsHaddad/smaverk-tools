// probe-detect.mjs: what the face detector sees at different scales of a frame from the fixture. Usage: bun tools/probe-detect.mjs
import { chromium } from "playwright"; import { spawn, execFileSync } from "node:child_process"; import { readFileSync } from "node:fs"; import { tmpdir } from "node:os";
const here = new URL(".", import.meta.url).pathname; const fx = here + "../tests/fixtures/talk-moving-face.mp4"; const d = tmpdir();
const frames = [["face crop t0 (500x700)", ["-vf", "crop=500:700:710:190"]], ["full 1920x1080", ["-vf", "scale=1920:1080"]], ["scan 320", ["-vf", "scale=320:180"]], ["scan 640", ["-vf", "scale=640:360"]], ["centre 2x (960x540 crop)", ["-vf", "crop=960:540:480:270"]], ["centre 3x (640x360 crop)", ["-vf", "crop=640:360:640:360"]]];
for (const [i, [, vf]] of frames.entries()) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "0.1", "-i", fx, ...vf, "-frames:v", "1", `${d}/probe-${i}.png`]);
const server = spawn("bun", [here + "../serve.ts", "8805"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); const p = await b.newPage(); await p.goto("http://localhost:8805/", { waitUntil: "load" });
await p.waitForFunction(() => window.__vert && window.__vert.state === "sample", null, { timeout: 30000 });
for (const [i, [name]] of frames.entries()) {
  const b64 = readFileSync(`${d}/probe-${i}.png`).toString("base64");
  const r = await p.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return window.vertical.detectOn(new Blob([bin], { type: "image/png" })); }, b64);
  console.log(name.padEnd(28), r.delegate, `${r.w}x${r.h}`, JSON.stringify(r.faces));
}
await b.close(); server.kill();
