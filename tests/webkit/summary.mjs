// summary.mjs <dir>: every row's report.json under <dir>, as one table and one summary.json. Files a row handed back
// without ffprobe on its machine (the Mac) are read here.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.argv[2] ?? "out";
const probe = (f) => {
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,sample_rate:format=duration,size", "-of", "json", f]).toString());
  const v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
  return { width: v?.width ?? null, height: v?.height ?? null, video: v?.codec_name ?? null, audio: a ? `${a.codec_name} ${a.sample_rate} Hz` : null, seconds: Number(p.format.duration), bytes: Number(p.format.size) };
};
const rows = [];
for (const row of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const f = join(dir, row, "report.json");
  if (!existsSync(f)) { rows.push({ row, ok: false, error: "no report (the job did not finish)" }); continue; }
  const r = JSON.parse(readFileSync(f, "utf8"));
  delete r.memSamples;
  for (const m of readdirSync(join(dir, row)).filter((n) => /\.(mp4|mov|webm)$/i.test(n))) r.files[m] ??= probe(join(dir, row, m));
  rows.push({ row, ...r });
}
writeFileSync(join(dir, "summary.json"), JSON.stringify(rows, null, 1));

const n = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
console.log("| row | engine | ok | find (s) | make (s) | per clip: work s / clip s | peak web process MB | all processes MB | files (ffprobe) | errors |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const res = r.result ?? {};
  const per = (res.clips ?? []).map((c) => `${n(c.workS, 1)} / ${n(c.lengthS, 1)}`).join(", ");
  const files = Object.entries(r.files ?? {}).map(([k, p]) => `${k.replace(/^.*-(\d+)-at-/, "#$1 @")}: ${p.width}x${p.height}, ${p.audio ? "sound" : "NO SOUND"}, ${n(p.seconds, 2)} s`).join("<br>");
  const errs = [r.error, ...(r.blockingErrors ?? [])].filter(Boolean).map((e) => String(e).split("\n")[0].slice(0, 160)).join("<br>");
  console.log(`| ${r.row} | ${r.engine ?? ""} ${(r.ua ?? "").match(/(Version\/[\d.]+|Chrome\/[\d.]+)/)?.[0] ?? ""} | ${r.ok ? "yes" : "NO"} | ${n(res.findS, 1)} | ${n(res.makeS, 1)} | ${per} | ${n(r.memory?.peakWebProcessMB)} | ${n(r.memory?.peakTotalMB)} | ${files} | ${errs || "none"} |`);
}
for (const r of rows) if (r.result?.features) console.log(`\n${r.row}: ${JSON.stringify(r.result.features)}; cross-origin isolated ${r.crossOriginIsolated}`);
