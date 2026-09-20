// Audio helpers: channel mix-down, trimming to the allowed length, and linear resampling to Whisper's 16 kHz.
export function toMono16k(chs: Float32Array[], rate: number, maxSeconds: number): Float32Array {
  const n = Math.min(chs[0].length, Math.floor(rate * maxSeconds)); const mono = new Float32Array(n);
  for (const d of chs) for (let i = 0; i < n; i++) mono[i] += d[i] / chs.length;
  if (rate === 16000) return mono;
  const m = Math.floor(n * 16000 / rate); const out = new Float32Array(m);
  for (let i = 0; i < m; i++) { const x = i * rate / 16000; const j = Math.floor(x); const t = x - j; out[i] = mono[j] * (1 - t) + (mono[Math.min(j + 1, n - 1)] ?? 0) * t; }
  return out;
}

/** Seconds of listening per second of audio: the device's last measured speed if known, else a guess from the core count. */
export function estimateFactor(device: string | undefined, cores: number, lastMs?: number, lastSecs?: number): number {
  if (lastMs && lastSecs) return lastMs / 1000 / lastSecs;
  if (device === "webgpu") return 0.6;
  return Math.min(3, 6 / Math.max(2, cores || 4));
}
