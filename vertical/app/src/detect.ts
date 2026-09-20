// detect.ts: who is in the clip and which of them is talking, a few times a second, found on the device with MediaPipe's
// face detector (BlazeFace short range, 230 KB, Apache-2.0) run through WebAssembly in the page. Frames come from the clip
// through Mediabunny (WebCodecs), drawn small before detection so a five-minute clip scans in well under its length.
// Since 2026-09-19 it keeps up to two people, measures mouth motion against eye motion for each of them between a pair of
// frames 0.08 s apart, and reads the sound level: track.ts turns that into the window following whoever is talking.
import { FilesetResolver, FaceDetector } from "@mediapipe/tasks-vision";
import { SPEAK, type Person, type SpeakerSample } from "./lib/track";
import { assignFaces, dedupe, lookPlan, talkScore, voicedFrom, type Face, type Look } from "./lib/scan";

// pair: mouth motion is measured between two frames 0.08 s apart, not between the 0.25 s samples. The study of 2026-09-19
// measured 93% right-man-in-frame at 0.08 s and 77% at 0.24 s: a quarter second is long enough for a whole head to move.
export const SCAN = { everySeconds: 0.25, width: 960, pair: 0.08, greyWidth: 480 }; // the frame is scanned at up to 960 px wide so a zoomed window still has detail
let det: FaceDetector | null = null; let loading: Promise<FaceDetector> | null = null; export let delegate = "";

/** Load the detector once (about 12 MB of WebAssembly plus the model, kept by the browser). GPU delegate when the browser offers it, CPU otherwise. */
export function loadDetector(): Promise<FaceDetector> {
  if (det) return Promise.resolve(det);
  if (!loading) loading = (async () => {
    // MediaPipe prints an INFO line ("Created TensorFlow Lite XNNPACK delegate") through console.error; keep it out of the error log.
    const orig = console.error.bind(console); console.error = (...a: any[]) => { if (!/TensorFlow Lite|XNNPACK/.test(String(a[0] ?? ""))) orig(...a); };
    // MediaPipe posts a small usage log to Google (odml.pa.googleapis.com) when a task starts. The page says nothing leaves the
    // device, so that one request is answered here and goes nowhere. Found by the cold-user round of 2026-09-18.
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: any, init?: any) => /^https:\/\/odml\.pa\.googleapis\.com\//.test(String(input?.url ?? input)) ? Promise.resolve(new Response(null, { status: 204 })) : realFetch(input, init)) as typeof fetch;
    const vision = await FilesetResolver.forVisionTasks("mediapipe");
    const make = (d: "GPU" | "CPU") => FaceDetector.createFromOptions(vision, { baseOptions: { modelAssetPath: "models/blaze_face_short_range.tflite", delegate: d }, runningMode: "VIDEO", minDetectionConfidence: 0.5 });
    // CPU (WebAssembly SIMD) by default: the model is tiny and fast enough, and the GPU delegate returned nothing at all in headless Chromium. ?delegate=gpu to try the other.
    const want = new URLSearchParams(location.search).get("delegate") === "gpu" ? "GPU" : "CPU";
    try { det = await make(want); delegate = want.toLowerCase(); } catch { det = await make("CPU"); delegate = "cpu"; }
    return det;
  })();
  return loading;
}

export type Scan = {
  speakers: SpeakerSample[]; width: number; height: number; seconds: number; ms: number; looks: number;
  bothFound: number; crowd: number; audio: boolean; audioError: string; combined: { hits: number; misses: number; used: boolean }; measured: number;
};

// The short-range model wants a face that fills a good part of its 128 px input, so a wide shot is searched in zoomed
// windows chosen by lookPlan. Coordinates come back as fractions of the whole frame. Windows always keep the frame's shape,
// so the squash into the square model input is the one the tool has always used. Units gotcha (2026-09-19): boundingBox is
// in pixels of the window canvas, keypoints are normalised 0 to 1.
let ts = 0; let looks = 0;
function lookAll(d: FaceDetector, src: HTMLCanvasElement, win: HTMLCanvasElement, wx: number, wy: number, ww: number, wh: number): Face[] {
  const c = win.getContext("2d", { alpha: false })!; c.drawImage(src, wx, wy, ww, wh, 0, 0, win.width, win.height); looks++;
  const res = d.detectForVideo(win, (ts += 40)); const out: Face[] = [];
  for (const det of res.detections) {
    const b = det.boundingBox; if (!b) continue;
    const fx = (px: number) => (wx + (px / win.width) * ww) / src.width, fy = (py: number) => (wy + (py / win.height) * wh) / src.height;
    const kx = (n: number) => (wx + n * ww) / src.width, ky = (n: number) => (wy + n * wh) / src.height;
    const k = det.keypoints ?? []; const x = fx(b.originX + b.width / 2), y = fy(b.originY + b.height / 2);
    const w = (b.width / win.width) * (ww / src.width), h = (b.height / win.height) * (wh / src.height);
    // BlazeFace returns six keypoints: the two eyes, the nose, the mouth and two ear points. A box with none of them (no
    // model does this today, but the type allows it) falls back to the lower and upper thirds of the face box.
    out.push({ x, y, w, h, score: det.categories?.[0]?.score ?? 0,
      mouth: k[3] ? { x: kx(k[3].x), y: ky(k[3].y) } : { x, y: y + h * 0.28 },
      eyes: k[0] && k[1] ? { x: (kx(k[0].x) + kx(k[1].x)) / 2, y: (ky(k[0].y) + ky(k[1].y)) / 2 } : { x, y: y - h * 0.18 } });
  }
  return out;
}

/** The sound level of every scan sample, in one pass over the sound track. Only asked for when two people were seen. */
async function listen(mb: any, input: any, first: number, total: number, n: number, onDone: (done: number) => Promise<void>): Promise<{ rms: number[]; audio: boolean; audioError: string }> {
  const rms = new Array<number>(n).fill(0);
  let at: any = null;
  try { at = await input.getPrimaryAudioTrack(); } catch (e: any) { return { rms, audio: false, audioError: String(e?.message ?? e) }; }
  if (!at) return { rms, audio: false, audioError: "" }; // a clip with no sound track: nothing is voiced, which is the one-face behaviour
  try {
    if (!(await at.canDecode())) return { rms, audio: false, audioError: `cannot decode ${at.codec ?? "unknown audio"} here` };
    const sum = new Float64Array(n), count = new Float64Array(n); const sink = new mb.AudioBufferSink(at); let paint = 0;
    for await (const wrapped of sink.buffers(first, first + total)) {
      if (!wrapped) continue;
      const buf = wrapped.buffer; const ch = buf.getChannelData(0); const rate = buf.sampleRate; const t0 = wrapped.timestamp - first; // the first channel is enough to hear a voice
      for (let j = 0; j < ch.length; j++) { const k = Math.floor((t0 + j / rate) / SCAN.everySeconds); if (k >= 0 && k < n) { sum[k]! += ch[j]! * ch[j]!; count[k]!++; } }
      if (t0 - paint > 2) { paint = t0; await onDone(t0); } // the bar keeps moving through this pass, and the page gets to paint
    }
    for (let k = 0; k < n; k++) rms[k] = count[k]! > 0 ? Math.sqrt(sum[k]! / count[k]!) : 0;
    return { rms, audio: true, audioError: "" };
  } catch (e: any) { return { rms, audio: false, audioError: String(e?.message ?? e) }; } // unreadable sound is not a reason to fail the clip: it falls back to one face
}

/**
 * Look at the clip every quarter second: both people (as fractions of the frame), how much each one's mouth is moving, and
 * whether there is sound. A clip with one person in it costs what it always did: the second frame of each pair, the pixel
 * work and the whole sound pass are only paid for once a second person has actually been seen.
 */
export async function scanClip(file: File, maxSeconds: number, onProgress: (done: number, total: number) => void): Promise<Scan> {
  const t0 = performance.now(); const d = await loadDetector(); const mb = await import("mediabunny"); looks = 0;
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
  try {
    const vt = await input.getPrimaryVideoTrack(); if (!vt) throw new Error("no video track");
    if (!(await vt.canDecode())) throw new Error(`cannot decode ${vt.codec ?? "unknown video"} here`);
    const W = await vt.getDisplayWidth(), H = await vt.getDisplayHeight();
    // Samples are anchored to the frames, not to the container: measured on the fixture, the container starts 23 ms before
    // the first frame (the sound track's encoder priming), and asking for a frame from before the clip returns nothing and
    // costs the first samples their face. The save counts from the container instead, so the window it draws is at most
    // that 23 ms — under one frame — away from the window the preview draws. Checked 2026-09-19 (code review, point 7).
    const first = await vt.getFirstTimestamp(); const total = Math.min(maxSeconds, (await vt.computeDuration()) - first);
    const times: number[] = []; for (let t = 0; t < total; t += SCAN.everySeconds) times.push(first + t);

    const sw = Math.min(W, SCAN.width), sh = Math.max(2, Math.round((sw * H) / W)); const src = document.createElement("canvas"); src.width = sw; src.height = sh; const sctx = src.getContext("2d", { alpha: false })!;
    const win = document.createElement("canvas"); win.width = 256; win.height = 256;
    // the pair of frames is compared on a small canvas: a mouth box is still a dozen pixels across there, and two reads of
    // half a megapixel per sample cost well under a millisecond
    const gw = Math.min(sw, SCAN.greyWidth), gh = Math.max(2, Math.round((gw * H) / W));
    const grey = document.createElement("canvas"); grey.width = gw; grey.height = gh; const gctx = grey.getContext("2d", { alpha: false, willReadFrequently: true })!;

    // windows are cut from the scan canvas, so they are measured in its pixels (sw × sh), not in the clip's own size
    const at = (l: Look) => { const ww = sw / l.zoom, wh = sh / l.zoom; return lookAll(d, src, win, Math.max(0, Math.min(sw - ww, l.cx * sw - ww / 2)), Math.max(0, Math.min(sh - wh, l.cy * sh - wh / 2)), ww, wh); };
    const prev: [Face | null, Face | null] = [null, null]; const lostFor: [number, number] = [99, 99]; // samples since each man was last found; 99: not found yet
    const combined = { hits: 0, misses: 0, used: true }; let misses = 0;
    const speakers: SpeakerSample[] = []; let both = 0, crowd = 0;

    /** Run a slot's looks, group by group, stopping at the first group that finds a face. */
    const runLooks = (plan: Look[]): Face[] => { const out: Face[] = []; let g = -1; for (const l of plan) { if (l.g !== g && out.length) break; g = l.g; out.push(...at(l)); } return out; };
    const gather = (i: number): Face[] => {
      const plan = lookPlan({ i, seconds: i * SCAN.everySeconds, prev, lostFor, combined: combined.used });
      if (plan.combined) {
        // One window holding both faces is half the detector calls. Whether the faces are big enough in it is a property of
        // the clip (the open question of the study, 2026-09-19), so it is tried and then believed or dropped. Two boxes on
        // one face are not two people, so the count is taken after the duplicates are dropped (code review, 2026-09-19).
        const got = dedupe(at(plan.combined));
        if (got.length >= 2) { combined.hits++; misses = 0; return got; }
        combined.misses++; if (++misses >= 3) combined.used = false; // three in a row: this clip's faces are too small in one window
        return [...got, ...runLooks(plan.slots[0]), ...runLooks(plan.slots[1])];
      }
      return [...runLooks(plan.slots[0]), ...runLooks(plan.slots[1])];
    };

    // Both frames of every pair are asked for: the decoder walks every frame of the clip anyway to reach the ones we ask
    // for, so the second one is nearly free. What is not free is the pixel work, and that is only done for a sample with
    // two people in it — which is where a mouth has to be compared with another mouth. Deciding that per sample keeps it
    // out of the hands of how far ahead the decoder reads: an earlier version left that to a flag the decoder ran past,
    // and the samples it skipped came back with mouth motion measured against the wrong frame (code review, 2026-09-19).
    const pairs: number[] = []; for (const t of times) pairs.push(t, t + SCAN.pair);
    const sink = new mb.VideoSampleSink(vt);
    const emit = (k: number, faces: [Face | null, Face | null], n: number, a: Uint8ClampedArray | null, b: Uint8ClampedArray | null) => {
      const person = (f: Face | null): Person | null => (f ? { cx: +f.x.toFixed(4), cy: +f.y.toFixed(4), w: +f.w.toFixed(4), talk: +talkScore(f, a, b, gw, gh).toFixed(3) } : null);
      const p: [Person | null, Person | null] = [person(faces[0]), person(faces[1])];
      if (p[0] && p[1]) both++;
      if (n >= 3) crowd++;
      speakers.push({ t: +(times[k]! - first).toFixed(2), p, n, voiced: false }); // voiced is filled in by the sound pass, if there is a reason to run one
    };
    // the search is 95% of the work; the sound pass, when it runs at all, is the rest, so the bar never sits still
    const phase = (done: number, from: number, to: number) => onProgress(total * (from + (to - from) * Math.min(1, done / Math.max(1e-6, total))), total);
    let i = 0, lastPaint = 0, pixels = 0; let pend: { faces: [Face | null, Face | null]; n: number; a: Uint8ClampedArray | null } | null = null;
    for await (const s of sink.samplesAtTimestamps(pairs)) {
      const idx = i++, k = idx >> 1;
      if ((idx & 1) === 1) { // the second frame of the pair, 0.08 s after the first
        let b: Uint8ClampedArray | null = null;
        if (s && pend?.a) { s.draw(gctx, 0, 0, gw, gh); b = gctx.getImageData(0, 0, gw, gh).data; }
        s?.close();
        emit(k, pend?.faces ?? [null, null], pend?.n ?? 0, pend?.a ?? null, b); pend = null;
        if (performance.now() - lastPaint > 200) { lastPaint = performance.now(); phase(times[k]! - first, 0, 0.95); await new Promise((r) => setTimeout(r, 0)); }
        continue;
      }
      if (!s) { pend = { faces: [null, null], n: 0, a: null }; continue; } // no frame here: nobody found, the window holds
      s.draw(sctx, 0, 0, sw, sh);
      const { pair, faces } = assignFaces(gather(k), prev);
      for (const q of [0, 1] as const) { if (pair[q]) { prev[q] = pair[q]; lostFor[q] = 0; } else lostFor[q]++; } // the last place he was seen is where he is looked for next
      let a: Uint8ClampedArray | null = null;
      if (pair[0] && pair[1]) { s.draw(gctx, 0, 0, gw, gh); a = gctx.getImageData(0, 0, gw, gh).data; pixels++; } // two people here: their mouths are worth measuring
      s.close(); pend = { faces: pair, n: faces, a };
    }
    if (pend) emit(times.length - 1, pend.faces, pend.n, pend.a, null); // the frames ran out mid-pair: the last sample has no second frame
    // Slots follow each man, not the x order, so the man found first holds slot 0 whichever side he is on. Once there are
    // two, name them left and right the once: a pure relabel, so nobody's history moves from under track.ts.
    const paired = speakers.find((s) => s.p[0] && s.p[1]);
    if (paired && paired.p[0]!.cx > paired.p[1]!.cx) for (const s of speakers) s.p = [s.p[1], s.p[0]];

    // The sound is only read when two people were seen often enough for it to decide anything; otherwise the whole pass is
    // skipped and every sample stays unvoiced, which is the one-face behaviour.
    const bothFound = speakers.length ? both / speakers.length : 0;
    let audio = false, audioError = "";
    if (bothFound >= SPEAK.bothMin && crowd < SPEAK.crowd) {
      const heard = await listen(mb, input, first, total, speakers.length, async (done) => { phase(done, 0.95, 1); await new Promise((r) => setTimeout(r, 0)); });
      audio = heard.audio; audioError = heard.audioError;
      const voiced = voicedFrom(heard.rms);
      for (const [i, s] of speakers.entries()) s.voiced = audio && (voiced[i] ?? false);
    }
    onProgress(total, total);
    return { speakers, width: W, height: H, seconds: total, ms: performance.now() - t0, looks, bothFound, crowd, audio, audioError, combined, measured: pixels };
  } finally { try { input.dispose(); } catch {} }
}
