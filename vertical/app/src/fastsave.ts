// fastsave.ts: write the finished clip faster than real time. Frames are decoded with WebCodecs (through Mediabunny),
// the caller draws each one (here: the moving 9:16 window) plus anything on top (the mark), the frames go into an
// H.264 encoder and an mp4; the sound is copied packet for packet, never re-encoded. Everything stays on the device.
// The page falls back to recording playback in real time when this path is unavailable, fails, or runs well under
// real time on the device (some laptops hand every decoded frame to a software canvas at 10+ ms a frame).
import { pickBitrate, snapFps } from "./lib/encode";

export type DrawFrame = (sample: any, c: CanvasRenderingContext2D, W: number, H: number, t: number) => void; // put the source frame on the output canvas
export type PaintOver = (c: CanvasRenderingContext2D, W: number, H: number, t: number) => void; // draw on top of it
export type Timing = { decode: number; draw: number; paint: number; encode: number; finalize: number };
export type Saved = { blob: Blob; ext: "mp4"; codec: string; audio: "copied" | "encoded" | "none"; seconds: number; frames: number; ms: number; timing: Timing; width: number; height: number };
export type FastOpts = Partial<{ latencyMode: "quality" | "realtime"; hardwareAcceleration: "no-preference" | "prefer-hardware" | "prefer-software"; bitrate: number; keyFrameInterval: number; codecs: ("avc" | "hevc" | "av1" | "vp9")[]; minSpeed: number }>;
export type SaveJob = { file: File; maxSeconds: number; from?: number; output: (srcW: number, srcH: number) => { width: number; height: number }; drawFrame: DrawFrame; paintOver?: PaintOver; onProgress: (done: number, total: number) => void; opts?: FastOpts };

export class TooSlow extends Error { constructor(speed: number, public timing: Timing) { super(`fast save is running at ${speed.toFixed(2)}× real time here`); } }
export function canFastSave(): boolean { return typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined"; }

export async function fastSave(job: SaveJob): Promise<Saved> {
  const { file, maxSeconds, drawFrame, paintOver, onProgress } = job; const o = job.opts ?? {};
  const t0 = performance.now(); const mb = await import("mediabunny"); const timing: Timing = { decode: 0, draw: 0, paint: 0, encode: 0, finalize: 0 };
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
  try {
    const vt = await input.getPrimaryVideoTrack(); if (!vt) throw new Error("no video track");
    if (!(await vt.canDecode())) throw new Error(`cannot decode ${vt.codec ?? "unknown video"} here`);
    const at = await input.getPrimaryAudioTrack();
    const srcW = await vt.getDisplayWidth(), srcH = await vt.getDisplayHeight(); const { width: W, height: H } = job.output(srcW, srcH);
    const fps = snapFps((await vt.computePacketStats(200)).averagePacketRate);
    // `from`: where the saved clip starts, on the file's clock. Vertical leaves it out and saves from the first frame; Clips passes 0
    // because its cuts are copied from the key frame before the moment, and that lead-in is not part of the clip.
    const first = job.from ?? (await input.getFirstTimestamp()); const total = Math.min(maxSeconds, (await input.computeDuration()) - first);
    const codec = await mb.getFirstEncodableVideoCodec(o.codecs ?? ["avc", "hevc", "av1", "vp9"], { width: W, height: H });
    if (!codec) throw new Error("no video encoder for this size");
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false }); if (!ctx) throw new Error("no canvas");
    const out = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
    const vsrc = new mb.CanvasSource(canvas, { codec, bitrate: o.bitrate ?? pickBitrate(W, H, fps), keyFrameInterval: o.keyFrameInterval ?? 2, latencyMode: o.latencyMode ?? "quality", hardwareAcceleration: o.hardwareAcceleration ?? "no-preference" });
    out.addVideoTrack(vsrc, { frameRate: fps });
    let acopy: InstanceType<typeof mb.EncodedAudioPacketSource> | null = null, aenc: InstanceType<typeof mb.AudioSampleSource> | null = null; let audio: Saved["audio"] = "none";
    if (at?.codec) {
      if (out.format.getSupportedCodecs().includes(at.codec)) { acopy = new mb.EncodedAudioPacketSource(at.codec); out.addAudioTrack(acopy); audio = "copied"; }
      else if (await at.canDecode()) { const ac = await mb.getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: at.numberOfChannels, sampleRate: at.sampleRate }); if (ac) { aenc = new mb.AudioSampleSource({ codec: ac, bitrate: 128_000 }); out.addAudioTrack(aenc); audio = "encoded"; } }
    }
    await out.start();
    if (at && acopy) {
      const sink = new mb.EncodedPacketSink(at); const meta = { decoderConfig: (await at.getDecoderConfig()) ?? undefined };
      for await (const p of sink.packets()) { const ts = p.timestamp - first; if (ts > total) break; if (ts + p.duration <= 0) continue; await acopy.add(p.clone({ timestamp: Math.max(0, ts) }), meta as any); }
    } else if (at && aenc) {
      const sink = new mb.AudioSampleSink(at);
      for await (const s of sink.samples(first, first + total)) { s.setTimestamp(Math.max(0, s.timestamp - first)); await aenc.add(s); s.close(); }
    }
    const sink = new mb.VideoSampleSink(vt); let frames = 0, last = -1, lastPaint = 0; let tw = performance.now(); const tv = tw; const minSpeed = o.minSpeed ?? 0.35;
    for await (const s of sink.samples(first, first + total)) {
      let tn = performance.now(); timing.decode += tn - tw; tw = tn;
      const ts = Math.max(0, s.timestamp - first);
      if (ts >= total || ts <= last) { s.close(); continue; }
      drawFrame(s, ctx, W, H, ts); tn = performance.now(); timing.draw += tn - tw; tw = tn;
      paintOver?.(ctx, W, H, ts); tn = performance.now(); timing.paint += tn - tw; tw = tn;
      await vsrc.add(ts, Math.max(0.001, Math.min(s.duration || 1 / fps, total - ts))); tn = performance.now(); timing.encode += tn - tw; tw = tn;
      s.close(); last = ts; frames++;
      if (tn - lastPaint > 250) {
        lastPaint = tn; onProgress(ts, total); await new Promise((r) => setTimeout(r, 0)); tw = performance.now();
        const speed = ts / ((tn - tv) / 1000);
        if (ts >= 6 && ts <= 12 && total - ts > 10 && speed < minSpeed) { await out.cancel().catch(() => {}); for (const k of Object.keys(timing) as (keyof Timing)[]) timing[k] = Math.round(timing[k]); throw new TooSlow(speed, timing); }
      }
    }
    if (!frames) throw new Error("no frames decoded");
    tw = performance.now(); await out.finalize(); timing.finalize = performance.now() - tw;
    const buf = (out.target as InstanceType<typeof mb.BufferTarget>).buffer; if (!buf) throw new Error("empty output");
    for (const k of Object.keys(timing) as (keyof Timing)[]) timing[k] = Math.round(timing[k]);
    return { blob: new Blob([buf], { type: "video/mp4" }), ext: "mp4", codec, audio, seconds: total, frames, ms: performance.now() - t0, timing, width: W, height: H };
  } finally { try { input.dispose(); } catch {} }
}

/** The real frame rate of a saved file, read back from the file itself. The recorder path writes in real time and can lose
 *  frames on a slow device without saying so (cold-user round, 2026-09-18: 8 to 11 frames a second from a 30 fps clip). */
export async function savedFps(blob: Blob): Promise<number | null> {
  try { const mb = await import("mediabunny"); const input = new mb.Input({ source: new mb.BlobSource(blob), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
    const vt = await input.getPrimaryVideoTrack(); if (!vt) return null; const s = await vt.computePacketStats(); return Number.isFinite(s.averagePacketRate) ? s.averagePacketRate : null; } catch { return null; }
}
