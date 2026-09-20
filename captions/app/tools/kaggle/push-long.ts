// push-long.ts: Kaggle script kernel that builds a 5-minute and a 60-second English test clip from a public-domain
// LibriVox reading, then runs probe-long.mjs against the live page.  bun push-long.ts [push|status|log]
import { readFileSync, writeFileSync } from "node:fs";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.kaggle/kaggle.json`, "utf8"));
const auth = { authorization: "Basic " + btoa(`${k.username}:${k.key}`) };
const slug = "captions-long-probe"; const dir = new URL(".", import.meta.url).pathname;
const probe = readFileSync(dir + "probe-long.mjs", "utf8");
const MP3 = "https://archive.org/download/pride_and_prejudice_librivox/prideandprejudice_01-03_austen_64kb.mp3";
const py = `import subprocess, os
os.makedirs('/kaggle/working', exist_ok=True)
open('/kaggle/working/probe-long.mjs', 'w').write(${JSON.stringify(probe)})
script = r'''
set -e
cd /kaggle/working
nproc; free -g | head -2
curl -fsSL "${MP3}" -o read.mp3
ffmpeg -v error -y -f lavfi -i "color=c=0x1c2440:s=480x854:r=24" -i read.mp3 -t 300 -shortest -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart long300.mp4
ffmpeg -v error -y -f lavfi -i "color=c=0x1c2440:s=480x854:r=24" -i read.mp3 -t 60 -shortest -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart short60.mp4
ls -la long300.mp4 short60.mp4
curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz -o node.tar.xz && tar -xJf node.tar.xz
export PATH=$PWD/node-v22.12.0-linux-x64/bin:$PATH
npm init -y >/dev/null 2>&1; npm i playwright@1.57.0 >/dev/null 2>&1
npx playwright install --with-deps chromium 2>&1 | tail -1
echo "== probe"; node probe-long.mjs
'''
r = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
print(r.stdout[-30000:])
print("STDERR:", r.stderr[-4000:])
`;
const cmd = process.argv[2] ?? "push";
if (cmd === "push") {
  const body = { slug: `${k.username}/${slug}`, newTitle: slug, text: py, language: "python", kernelType: "script", isPrivate: true, enableGpu: false, enableTpu: false, enableInternet: true, datasetDataSources: [], competitionDataSources: [], kernelDataSources: [], modelDataSources: [], categoryIds: [] };
  const r = await fetch("https://www.kaggle.com/api/v1/kernels/push", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log("push", r.status, (await r.text()).slice(0, 300));
} else if (cmd === "status") {
  const r = await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${k.username}&kernelSlug=${slug}`, { headers: auth });
  console.log("status", r.status, (await r.text()).slice(0, 300));
} else if (cmd === "log") {
  const r = await fetch(`https://www.kaggle.com/api/v1/kernels/output?userName=${k.username}&kernelSlug=${slug}`, { headers: auth });
  const j: any = await r.json().catch(() => null); const log = j?.log ?? JSON.stringify(j).slice(0, 2000);
  let text = log; try { const arr = JSON.parse(log); if (Array.isArray(arr)) text = arr.map((e: any) => e.data ?? "").join(""); } catch {}
  writeFileSync(dir + "kaggle-long-log.txt", text); console.log(text.slice(-8000));
}
