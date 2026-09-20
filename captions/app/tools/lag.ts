// lag.ts <audio.wav 16k mono s16> <words.json>: the shift (s) that best lines word intervals up with the voice's energy envelope
const [wav, wj] = process.argv.slice(2); const buf = new Uint8Array(await Bun.file(wav!).arrayBuffer()); const dv = new DataView(buf.buffer);
let off = 12, data = 0, len = 0; while (off + 8 <= buf.length) { const id = String.fromCharCode(...buf.slice(off, off + 4)); const sz = dv.getUint32(off + 4, true); if (id === "data") { data = off + 8; len = sz; break; } off += 8 + sz + (sz & 1); }
const pcm = new Int16Array(buf.buffer, data, Math.floor(Math.min(len, buf.length - data) / 2)); const hop = 160; const n = Math.floor(pcm.length / hop); const env = new Float32Array(n);
for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < hop; j++) { const v = pcm[i * hop + j]! / 32768; s += v * v; } env[i] = Math.sqrt(s / hop); }
const max = env.reduce((a, b) => Math.max(a, b), 0); const words: { start: number; end: number }[] = JSON.parse(await Bun.file(wj!).text());
for (const th of [0.08, 0.12, 0.18]) { let best = { shift: 0, agree: 0 }, at0 = 0;
  for (let sh = -50; sh <= 50; sh++) { const mask = new Uint8Array(n); for (const w of words) for (let i = Math.max(0, Math.round((w.start + sh / 100) * 100)); i < Math.min(n, Math.round((w.end + sh / 100) * 100)); i++) mask[i] = 1;
    let ok = 0; for (let i = 0; i < n; i++) if ((env[i]! > th * max ? 1 : 0) === mask[i]) ok++; const a = ok / n; if (sh === 0) at0 = a; if (a > best.agree) best = { shift: sh / 100, agree: a }; }
  console.log(`threshold ${th}: best shift ${best.shift.toFixed(2)} s (agreement ${best.agree.toFixed(3)}; at 0: ${at0.toFixed(3)})`); }
