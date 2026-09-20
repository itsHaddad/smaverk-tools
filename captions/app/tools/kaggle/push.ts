// push.ts: push a Kaggle script kernel (GPU + internet) that installs Node + Playwright Chromium and runs probe.mjs
// against the live captions page; then poll until it finishes and print the log.  bun push.ts [push|status|log]
import { readFileSync, writeFileSync } from "node:fs";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.kaggle/kaggle.json`, "utf8"));
const auth = { authorization: "Basic " + btoa(`${k.username}:${k.key}`) };
const slug = "captions-webgpu-probe"; const dir = new URL(".", import.meta.url).pathname;
const probe = readFileSync(dir + "probe.mjs", "utf8");
const py = `import subprocess, os
os.makedirs('/kaggle/working', exist_ok=True)
open('/kaggle/working/probe.mjs', 'w').write(${JSON.stringify(probe)})
script = r'''
set -e
cd /kaggle/working
echo "== gpu"; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv || true
echo "== cpu"; nproc; grep -m1 "model name" /proc/cpuinfo; free -g | head -2
curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz -o node.tar.xz && tar -xJf node.tar.xz
export PATH=$PWD/node-v22.12.0-linux-x64/bin:$PATH
node -v
npm init -y >/dev/null 2>&1; npm i playwright@1.57.0 >/dev/null 2>&1
npx playwright install --with-deps chromium 2>&1 | tail -2
(apt-get install -y -q libvulkan1 vulkan-tools >/dev/null 2>&1 && (vulkaninfo --summary 2>/dev/null | grep -i "deviceName\\|driverName" | head -6)) || echo "no vulkan tools"
ls /usr/share/vulkan/icd.d 2>/dev/null || echo "no vulkan icd"
curl -fsSL https://captions.smaverk.com/sample.mp4 -o sample.mp4
echo "== probe"; node probe.mjs
'''
r = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
print(r.stdout[-30000:])
print("STDERR:", r.stderr[-6000:])
`;
const cmd = process.argv[2] ?? "push";
if (cmd === "push") {
  const body = { slug: `${k.username}/${slug}`, newTitle: slug, text: py, language: "python", kernelType: "script", isPrivate: true, enableGpu: true, enableTpu: false, enableInternet: true, datasetDataSources: [], competitionDataSources: [], kernelDataSources: [], modelDataSources: [], categoryIds: [] };
  const r = await fetch("https://www.kaggle.com/api/v1/kernels/push", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log("push", r.status, (await r.text()).slice(0, 400));
} else if (cmd === "status") {
  const r = await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${k.username}&kernelSlug=${slug}`, { headers: auth });
  console.log("status", r.status, (await r.text()).slice(0, 300));
} else if (cmd === "log") {
  const r = await fetch(`https://www.kaggle.com/api/v1/kernels/output?userName=${k.username}&kernelSlug=${slug}`, { headers: auth });
  const j: any = await r.json().catch(() => null); const log = j?.log ?? JSON.stringify(j).slice(0, 2000);
  let text = log; try { const arr = JSON.parse(log); if (Array.isArray(arr)) text = arr.map((e: any) => e.data ?? "").join(""); } catch {}
  writeFileSync(dir + "kaggle-log.txt", text); console.log(text.slice(-6000));
}
