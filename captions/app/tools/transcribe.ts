// transcribe.ts: word timestamps for a WAV using the same Whisper model the page uses (CPU, q8).
//   bun tools/transcribe.ts <file.wav> > words.json
import { pipeline } from "@huggingface/transformers";
import { earlier } from "../src/lib/windows"; // the same timing correction the page applies
const buf = new Uint8Array(await Bun.file(process.argv[2]).arrayBuffer());
const dv = new DataView(buf.buffer);
let off = 12; let pcm: Int16Array | Float32Array | null = null; let rate = 16000; let ch = 1; let fmt = 1; let bits = 16;
while (off + 8 <= buf.length) { const id = String.fromCharCode(...buf.slice(off, off + 4)); const sz = dv.getUint32(off + 4, true); if (id === "fmt ") { fmt = dv.getUint16(off + 8, true); ch = dv.getUint16(off + 10, true); rate = dv.getUint32(off + 12, true); bits = dv.getUint16(off + 22, true); } if (id === "data") { const n = Math.min(sz, buf.length - off - 8); pcm = fmt === 3 || bits === 32 ? new Float32Array(buf.buffer.slice(off + 8, off + 8 + n - (n % 4))) : new Int16Array(buf.buffer.slice(off + 8, off + 8 + n - (n % 2))); break; } off += 8 + sz + (sz & 1); }
if (!pcm) throw new Error("no data chunk");
const mono = new Float32Array(Math.floor(pcm.length / ch)); for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < ch; c++) s += pcm[i * ch + c]; mono[i] = pcm instanceof Float32Array ? s / ch : s / ch / 32768; }
let f = mono; if (rate !== 16000) { const n = Math.floor(mono.length * 16000 / rate); f = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * rate / 16000; const j = Math.floor(x); const t = x - j; f[i] = mono[j] * (1 - t) + (mono[Math.min(j + 1, mono.length - 1)] ?? 0) * t; } }
const asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny_timestamped", { dtype: "q8" } as any);
const t0 = performance.now();
const out: any = await asr(f, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
const words = (out.chunks ?? []).map((c: any) => ({ text: String(c.text).trim(), start: +(c.timestamp[0] ?? 0).toFixed(2), end: +((c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.4)).toFixed(2) })).filter((w: any) => w.text);
console.error(`${words.length} words in ${Math.round(performance.now() - t0)} ms, ${(f.length / 16000).toFixed(1)} s audio`);
console.log(JSON.stringify(earlier(words)));
