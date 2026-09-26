// make.ts: one kept moment in, one finished clip out. Everything here runs on the device, one moment at a time.
//
//   1. cut      the moment is copied out of the recording (the clip finder's own cut: no re-encoding where it can)
//   2. frame    Vertical's scan finds the speaker in the cut, and its track decides where the 9:16 window goes
//   3. listen   Captions' engine hears the cut's sound, in its own worker, and hands back the words with their times
//   4. save     Vertical's save writes the 9:16 file, and Captions' drawing burns each line into every frame
//
// Nothing from the three tools is copied here: each step calls the tool's own module. The one thing this file owns is
// the clock. A cut copied without re-encoding starts at the key frame before the moment, so its picture can begin a
// little before zero. The save starts at zero (`from: 0`), the words are heard on the same clock (`alignToZero`), and
// the speaker track, which Vertical measures from the first frame, is read `videoFirst` seconds later.

import { scanClip, loadDetector } from "../../../vertical/app/src/detect";
import { pickSpeaker, SPEAK, buildTrack, centreAt, cropRect, outputSize, windowFraction, type Point } from "../../../vertical/app/src/lib/track";
import { fastSave, canFastSave } from "../../../vertical/app/src/fastsave";
import { buildLines, lineAt, type Word } from "../../../captions/app/src/lib/lines";
import { drawCaption, drawMark, type Style } from "../../../captions/app/src/draw";
import { Mono16kStream, SAMPLE_RATE } from "../../../clipfinder/app/src/lib/decode";
import { alignToZero, sentenceEnd } from "./lib/plan";

export type Phase = "cut" | "frame" | "listen" | "save";
export type Made = {
  blob: Blob;
  /** Length of the saved clip, seconds, as the save wrote it. */
  seconds: number;
  width: number;
  height: number;
  audio: "copied" | "encoded" | "none";
  words: number;
  /** Frames that had a caption line drawn on them. */
  captionFrames: number;
  frames: number;
  /** Where the clip ends on the recording's clock, after a capped clip moved back to a finished sentence. */
  endS: number;
  found: number;
  ms: Record<Phase, number>;
};
export type MakeJob = {
  file: File;
  startS: number;
  endS: number;
  /** The clip was cut to the cap, so it may end earlier, on a finished sentence. */
  capped: boolean;
  mark: boolean;
  style: Style;
  listen: (audio: Float32Array) => Promise<Word[]>;
  onPhase: (p: Phase, done: number, of: number) => void;
};

export const saveAvailable = canFastSave;
export const warmFraming = () => loadDetector();

/** The moment, copied out of the recording into a small file of its own, and where its first frame sits. */
async function cut(file: File, startS: number, endS: number): Promise<{ file: File; videoFirst: number }> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const conv = await mb.Conversion.init({ input, output, trim: { start: startS, end: endS }, showWarnings: false });
    if (!conv.isValid) throw new Error(`the recording could not be cut here (${conv.discardedTracks.map((d) => d.reason).join(", ") || "no reason given"})`);
    await conv.execute();
    const buf = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
    if (!buf) throw new Error("the cut came back empty");
    const out = new File([buf], "moment.mp4", { type: "video/mp4" });
    const back = new mb.Input({ source: new mb.BlobSource(out), formats: mb.ALL_FORMATS });
    try {
      const vt = await back.getPrimaryVideoTrack();
      if (!vt) throw new Error("this recording has no picture, so there is nothing to frame");
      return { file: out, videoFirst: await vt.getFirstTimestamp() };
    } finally {
      back.dispose();
    }
  } finally {
    input.dispose();
  }
}

/** The cut's sound as 16 kHz mono from zero to `lengthS`, on the picture's clock. Empty when the cut has no sound. */
async function soundOf(file: File, lengthS: number): Promise<Float32Array> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return new Float32Array(0); // a silent video: no words, the clip is still framed and saved
    if (!(await track.canDecode())) throw new Error(`the sound in this recording cannot be read here (${track.codec ?? "unknown kind"})`);
    const sink = new mb.AudioSampleSink(track);
    const rs = new Mono16kStream();
    const parts: Float32Array[] = [];
    let planes: Float32Array[] = [];
    let first: number | null = null;
    let total = 0;
    for await (const s of sink.samples(0, lengthS)) {
      first ??= s.timestamp;
      const nch = s.numberOfChannels, frames = s.numberOfFrames;
      if (planes.length < nch) planes = Array.from({ length: nch }, () => new Float32Array(0));
      for (let c = 0; c < nch; c++) {
        if (planes[c]!.length < frames) planes[c] = new Float32Array(Math.max(frames, 4096));
        s.copyTo(planes[c]!.subarray(0, frames), { planeIndex: c, format: "f32-planar" });
      }
      const rate = s.sampleRate;
      s.close();
      const mono = rs.push(planes.slice(0, nch), frames, rate);
      parts.push(mono.slice()); // borrowed until the next push
      total += mono.length;
    }
    const all = new Float32Array(total);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const aligned = alignToZero(all, first ?? 0, SAMPLE_RATE);
    return aligned.subarray(0, Math.min(aligned.length, Math.round(lengthS * SAMPLE_RATE)));
  } finally {
    input.dispose();
  }
}

/** One moment, all four steps. Throws with the step's name in the message, so the page can say which step failed. */
export async function makeClip(job: MakeJob): Promise<Made> {
  const ms: Record<Phase, number> = { cut: 0, frame: 0, listen: 0, save: 0 };
  let t = performance.now();
  const lap = (p: Phase) => { const n = performance.now(); ms[p] = Math.round(n - t); t = n; };
  let lengthS = job.endS - job.startS;
  const step = async <T>(p: Phase, f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) { throw Object.assign(new Error(`${p}: ${String((e as Error)?.message ?? e)}`), { phase: p }); }
  };

  job.onPhase("cut", 0, 1);
  const c = await step("cut", () => cut(job.file, job.startS, job.endS));
  lap("cut");

  job.onPhase("frame", 0, lengthS);
  const scan = await step("frame", () => scanClip(c.file, lengthS - c.videoFirst + 1, (d, of) => job.onPhase("frame", d, of)));
  // Vertical's default for a two-person shot: the calm pan on one face (its ?two=1 following is off until it holds on clips nobody tuned it on).
  const picked = pickSpeaker(scan.speakers, { ...SPEAK, bothMin: 2 });
  const found = picked.samples.filter((s) => s.x !== null).length / Math.max(1, picked.samples.length);
  const track: Point[] = found >= 0.1 ? buildTrack(picked.samples, picked.cutAt, undefined, windowFraction(scan.width, scan.height)) : []; // no face: the window holds the middle
  lap("frame");

  job.onPhase("listen", 0, 1);
  const words = await step("listen", async () => {
    const audio = await soundOf(c.file, lengthS);
    return audio.length ? job.listen(audio) : [];
  });
  lap("listen");

  // A clip cut to the cap ends on the last finished sentence it heard, so the clean-edges rule still holds.
  if (job.capped) lengthS = Math.min(lengthS, sentenceEnd(words, lengthS));
  const lines = buildLines(words.filter((w) => w.start < lengthS));
  let captionFrames = 0;

  job.onPhase("save", 0, lengthS);
  const saved = await step("save", () =>
    fastSave({
      file: c.file,
      from: 0,
      maxSeconds: lengthS,
      output: (w, h) => outputSize(w, h),
      drawFrame: (s, g, W, H, ts) => {
        const { cx, cy } = track.length ? centreAt(track, ts - c.videoFirst) : { cx: 0.5, cy: 0.5 };
        const r = cropRect(cx, cy, s.displayWidth, s.displayHeight);
        // Vertical's own fast path: one crop straight from the decoded frame; a rotated or flipped source takes the slow, correct one.
        if (s.rotation === 0 && !s.flip) { const vf = s.toVideoFrame(); g.drawImage(vf, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H); if (vf !== (s as any)._data) vf.close(); }
        else s.draw(g, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
      },
      paintOver: (g, W, H, ts) => {
        const line = lineAt(lines, ts, 6);
        if (line) captionFrames++;
        drawCaption(g, W, H, line, job.style, { x: null, y: null });
        if (job.mark) drawMark(g, W, H);
      },
      onProgress: (d, of) => job.onPhase("save", d, of),
      opts: { minSpeed: 0 }, // Clips has no real-time recorder to fall back to, so a slow device finishes slowly rather than giving up
    }),
  );
  lap("save");
  return { blob: saved.blob, seconds: saved.seconds, width: saved.width, height: saved.height, audio: saved.audio, words: words.length, captionFrames, frames: saved.frames, endS: job.startS + lengthS, found, ms };
}
