// Windowed audio decode, in the browser.
//
// The rule this file exists to obey: peak memory is O(one window), never O(recording length). Captions'
// audio path keeps every decoded chunk at the source rate and then allocates a second full-length array
// to join them — about 2 × duration × rate × channels × 4 bytes, which is 2.8 GB for an hour. A tab has
// one to one and a half. So nothing here is kept: source chunk → mix to mono → area-average resample to
// 16 kHz → fill one fixed window buffer → hand it out → reuse the same buffer.
//
// Measured on the command-line twin of this file (`clipfinder/engine/decode.ts`): sixty minutes of
// 48 kHz stereo holds 2.9 MB of heap and 12.8 MB outside it, the same at the last window as at the
// first. The window buffer is REUSED: `window.samples` is only valid until the next one is pulled.

import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from "mediabunny";

export const SAMPLE_RATE = 16000;

export type AudioWindow = {
  index: number;
  /** Start of this window in the recording, in seconds. */
  startS: number;
  endS: number;
  /** Seconds at the head of this window that the previous window already covered. */
  overlapS: number;
  /** Mono 16 kHz samples. Valid until the next window is pulled. */
  samples: Float32Array;
};

/**
 * Mixes to mono and resamples to 16 kHz as chunks arrive, keeping phase across chunk boundaries.
 *
 * Downsampling averages every source sample inside an output sample's span, which is a cheap
 * anti-alias filter. Plain linear interpolation folds everything above 8 kHz back into the band the
 * speech model is then asked to read.
 */
export class Mono16kStream {
  private rate = 0;
  private pending = new Float32Array(0);
  private pendingLen = 0;
  private frac = 0;
  private out = new Float32Array(0);

  /** Feed one chunk. Returns 16 kHz mono samples — borrowed, valid until the next push. */
  push(channels: Float32Array[], frames: number, sampleRate: number): Float32Array {
    if (sampleRate !== this.rate) {
      // A rate change mid-file would desync the clock; treat it as a fresh stream.
      this.rate = sampleRate;
      this.pendingLen = 0;
      this.frac = 0;
    }
    const need = this.pendingLen + frames;
    if (this.pending.length < need) {
      const grown = new Float32Array(Math.max(need, this.pending.length * 2, 8192));
      grown.set(this.pending.subarray(0, this.pendingLen));
      this.pending = grown;
    }
    const p = this.pending;
    const base = this.pendingLen;
    const nch = channels.length;
    if (nch === 1) p.set(channels[0]!.subarray(0, frames), base);
    else {
      p.fill(0, base, base + frames);
      const inv = 1 / nch;
      for (let c = 0; c < nch; c++) {
        const ch = channels[c]!;
        for (let i = 0; i < frames; i++) p[base + i] = p[base + i]! + ch[i]! * inv;
      }
    }
    this.pendingLen = need;

    const step = sampleRate / SAMPLE_RATE;
    const produce = Math.max(0, Math.floor((this.pendingLen - this.frac) / step));
    if (this.out.length < produce) this.out = new Float32Array(Math.max(produce, 4096));
    const out = this.out;
    let t = this.frac;
    if (step <= 1) {
      for (let k = 0; k < produce; k++) {
        const j = Math.floor(t);
        const f = t - j;
        const a = p[j] ?? 0;
        const b = p[Math.min(j + 1, this.pendingLen - 1)] ?? a;
        out[k] = a * (1 - f) + b * f;
        t += step;
      }
    } else {
      for (let k = 0; k < produce; k++) {
        const end = t + step;
        let acc = 0;
        let i = Math.floor(t);
        acc += (p[i] ?? 0) * (Math.min(i + 1, end) - t);
        i++;
        const lastFull = Math.floor(end);
        for (; i < lastFull; i++) acc += p[i] ?? 0;
        if (lastFull > Math.floor(t) && lastFull < this.pendingLen) acc += (p[lastFull] ?? 0) * (end - lastFull);
        out[k] = acc / step;
        t = end;
      }
    }
    const consumed = Math.floor(t);
    if (consumed > 0) {
      p.copyWithin(0, consumed, this.pendingLen);
      this.pendingLen -= consumed;
      t -= consumed;
    }
    this.frac = t;
    return out.subarray(0, produce);
  }
}

export type Reading = {
  /** Seconds of sound, when the file says so. */
  durationS: number | undefined;
  hasVideo: boolean;
  /** Frames a second of the picture, or 30 when there is no picture: an edit list needs a rate. */
  fps: number;
  windows: (windowSeconds: number, overlapSeconds: number) => AsyncGenerator<AudioWindow>;
  dispose: () => void;
};

/**
 * Open the person's file. mediabunny reads it off disk in ranges through `BlobSource` and decodes it a
 * packet at a time, so the File itself is never pulled into memory — which is the only reason a
 * two-hour recording can be read in a tab at all.
 */
export async function open(file: Blob): Promise<Reading> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("This file has no sound in it.");
  if (!(await track.canDecode())) throw new Error(`The sound in this file cannot be read here (${track.codec ?? "unknown kind"}).`);
  const video = await input.getPrimaryVideoTrack();
  let durationS: number | undefined;
  try {
    durationS = await input.computeDuration();
  } catch {
    durationS = undefined; // a stream without a duration: the last window sets the end instead
  }
  let fps = 30;
  if (video) {
    try {
      const stats = await video.computePacketStats(120);
      if (stats?.averagePacketRate && stats.averagePacketRate > 1) fps = Math.round(stats.averagePacketRate);
    } catch {
      fps = 30; // the rate could not be read; an edit list still needs one and 30 is the safe guess
    }
  }

  return {
    durationS,
    hasVideo: !!video,
    fps,
    dispose: () => {
      try {
        input.dispose?.();
      } catch {
        /* already gone */
      }
    },
    async *windows(windowSeconds: number, overlapSeconds: number) {
      const windowLen = Math.round(windowSeconds * SAMPLE_RATE);
      const overlapLen = Math.round(Math.min(overlapSeconds, windowSeconds / 2) * SAMPLE_RATE);
      const acc = new Float32Array(windowLen); // the one and only window buffer
      let accLen = 0;
      const resampler = new Mono16kStream();
      let index = 0;
      let emitted = 0;
      let first = true;
      const sink = new AudioSampleSink(track);
      let planes: Float32Array[] = [];
      for await (const s of sink.samples()) {
        const nch = s.numberOfChannels;
        const frames = s.numberOfFrames;
        if (planes.length < nch) planes = Array.from({ length: nch }, () => new Float32Array(0));
        for (let c = 0; c < nch; c++) {
          if (planes[c]!.length < frames) planes[c] = new Float32Array(Math.max(frames, 4096));
          s.copyTo(planes[c]!.subarray(0, frames), { planeIndex: c, format: "f32-planar" });
        }
        const rate = s.sampleRate;
        s.close();
        const mono = resampler.push(planes.slice(0, nch), frames, rate);
        let off = 0;
        while (off < mono.length) {
          const take = Math.min(windowLen - accLen, mono.length - off);
          acc.set(mono.subarray(off, off + take), accLen);
          accLen += take;
          off += take;
          if (accLen === windowLen) {
            const startS = emitted / SAMPLE_RATE;
            yield { index: index++, startS, endS: startS + windowSeconds, overlapS: first ? 0 : overlapLen / SAMPLE_RATE, samples: acc.subarray(0, windowLen) };
            first = false;
            if (overlapLen > 0) acc.copyWithin(0, windowLen - overlapLen, windowLen);
            accLen = overlapLen;
            emitted += windowLen - overlapLen;
          }
        }
      }
      if (accLen > (first ? 0 : overlapLen)) {
        const startS = emitted / SAMPLE_RATE;
        yield { index: index++, startS, endS: startS + accLen / SAMPLE_RATE, overlapS: first ? 0 : overlapLen / SAMPLE_RATE, samples: acc.subarray(0, accLen) };
      }
    },
  };
}
