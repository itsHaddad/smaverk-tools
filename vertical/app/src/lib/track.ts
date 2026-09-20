// track.ts: where the crop window goes over time (pure, tested).
// The detector gives a rough face position a few times a second; this turns it into a calm camera move: gaps filled,
// jitter ignored, pans limited to a speed the eye accepts, and the window kept inside the picture.

export type Sample = { t: number; x: number; y: number; w: number } | { t: number; x: null; y?: null; w?: null }; // x, y: face centre as a fraction of the frame; w: face width as a fraction
export type Point = { t: number; cx: number; cy: number; jump?: 1 }; // jump: the window steps here instead of panning (a speaker change)
export const TRACK = { deadZone: 0.03, maxPanPerSecond: 0.35, smooth: 0.35, holdSeconds: 2.5 };

/** Rough detector samples → a calm crop-centre track at the same times. Missing faces hold the last position; a long gap eases back to the middle. */
export function smoothTrack(samples: Sample[], o = TRACK): Point[] {
  if (!samples.length) return [];
  const out: Point[] = []; let cx = 0.5, cy = 0.5, tx = 0.5, ty = 0.5, lastSeen = -Infinity, prevT = samples[0].t;
  // first known position becomes the starting point, so the clip does not begin with a pan from the middle
  const first = samples.find((s) => s.x !== null) as { x: number; y: number } | undefined; if (first) { cx = tx = first.x; cy = ty = first.y; }
  for (const s of samples) {
    const dt = Math.max(0, s.t - prevT); prevT = s.t;
    if (s.x !== null && s.x !== undefined) {
      // a target only moves when the face has really moved (dead zone), which kills detector jitter
      if (Math.abs(s.x - tx) > o.deadZone) tx = s.x; if (Math.abs((s.y ?? 0.5) - ty) > o.deadZone) ty = s.y ?? 0.5; lastSeen = s.t;
    } else if (s.t - lastSeen > o.holdSeconds) { tx += (0.5 - tx) * 0.1; ty += (0.5 - ty) * 0.1; } // nobody in frame for a while: drift back to the middle
    // ease towards the target, but never faster than the pan limit
    const step = Math.min(1, o.smooth + dt * 0.5); let nx = cx + (tx - cx) * step, ny = cy + (ty - cy) * step;
    const lim = o.maxPanPerSecond * Math.max(dt, 1e-3); nx = cx + Math.max(-lim, Math.min(lim, nx - cx)); ny = cy + Math.max(-lim, Math.min(lim, ny - cy));
    cx = nx; cy = ny; out.push({ t: s.t, cx: +cx.toFixed(4), cy: +cy.toFixed(4) });
  }
  return out;
}

/** The crop centre at time t, interpolated between track points; the middle when there is no track. */
export function centreAt(track: Point[], t: number): { cx: number; cy: number } {
  if (!track.length) return { cx: 0.5, cy: 0.5 };
  if (t <= track[0].t) return { cx: track[0].cx, cy: track[0].cy };
  const last = track[track.length - 1]; if (t >= last.t) return { cx: last.cx, cy: last.cy };
  let lo = 0, hi = track.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (track[m].t <= t) lo = m; else hi = m; }
  const a = track[lo], b = track[hi];
  // A cut is a cut: the window steps to the other man at b.t. Interpolating would slide it across the quarter second between
  // the two samples, which is what the preview, the yellow window and the saved file would all show (2026-09-19).
  if (b.jump) return { cx: a.cx, cy: a.cy };
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
}

/** The source rectangle to cut for a vertical frame: full height, 9:16 wide, centred on cx and kept inside the picture. Sources already narrower than 9:16 are used whole. */
export function cropRect(cx: number, cy: number, srcW: number, srcH: number, aspect = 9 / 16): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW / srcH <= aspect + 1e-6) { const sh = Math.min(srcH, Math.round(srcW / aspect)); return { sx: 0, sy: Math.round(Math.max(0, Math.min(srcH - sh, cy * srcH - sh / 2))), sw: srcW, sh }; }
  const sw = Math.round(srcH * aspect); const sx = Math.round(Math.max(0, Math.min(srcW - sw, cx * srcW - sw / 2)));
  return { sx, sy: 0, sw, sh: srcH };
}

/** How wide the 9:16 window is, as a fraction of the source width (0.3164 of a 16:9 frame; 1 for a source already narrow). */
export function windowFraction(srcW: number, srcH: number, aspect = 9 / 16): number { return cropRect(0.5, 0.5, srcW, srcH, aspect).sw / srcW; }

// ---------- two people: follow whoever is talking ----------
// Two podcast hosts, 2026-09-19: following whoever talks in a two-person shot is the reason they keep paying for the other tool.
// The study of the same day measured the signal on a real two-man clip: the mouth of the man who is talking moves more than
// the rest of his face, so talk = motion in the mouth box over motion in the eyes box, between two frames 0.08 s apart. The
// eyes divide matters: a listener who turns to look at the talker moves his mouth as much as talking does, and a hard cut in
// the source moves both boxes equally, so the ratio ignores both. Everything below works on those per-sample numbers.
// Knobs from the study (insensitive: hold 1.0 to 2.0 s, lead 1.3 to 1.45 all gave the same three switches on the fixture).
export type Person = { cx: number; cy: number; w: number; talk: number }; // cx, cy, w as fractions of the frame; talk as above
export type SpeakerSample = { t: number; p: [Person | null, Person | null]; voiced: boolean; n?: number }; // p: the two people, left first; voiced: there is sound here; n: how many faces were in this sample
export const SPEAK = { win: 1.0, lead: 1.3, margin: 0.05, hold: 1.5, bothMin: 0.2, lost: 2.0, crowd: 8 }; // crowd: samples with three or more faces (about two seconds) after which this is a room, not a two-shot
export type Picked = {
  samples: Sample[]; // where the window should look, one per scan sample: the chosen man's face, or nothing when he is not in this sample
  cutAt: number[]; // sample indexes where the chosen man changed (the track may step there instead of panning)
  switches: number[]; // the times of the speaker changes a person would notice (the opening choice is not one)
  picks: (0 | 1 | null)[]; // who the window was on, per sample
  bothFound: number; // share of samples with two faces
  two: boolean; // whether the two-person rules ran at all
};

/**
 * Per-sample faces and sound → which man the window follows, sample by sample.
 * One face, a second face in fewer than 20% of the samples, or a clip with no sound to gate on: the larger face, which is
 * exactly what the tool did before this existed. Two faces and sound: the talk scores are averaged over a second, and the
 * window moves to the other man only when he beats the current one by the lead and the hold has passed since the last move.
 */
export function pickSpeaker(ss: SpeakerSample[], o = SPEAK): Picked {
  const at = (t: number, p: Person | null): Sample => (p ? { t, x: +p.cx.toFixed(4), y: +p.cy.toFixed(4), w: +p.w.toFixed(4) } : { t, x: null });
  const bothFound = ss.length ? ss.filter((s) => s.p[0] && s.p[1]).length / ss.length : 0;
  // A third person keeps arriving: with more than two there is no "the other man" to cut to, and picking two of three by
  // size makes the window shake between them (code review, 2026-09-19). A room full of faces gets the calm one-face pan.
  const crowded = ss.filter((s) => (s.n ?? 0) >= 3).length >= o.crowd;
  if (bothFound < o.bothMin || crowded || !ss.some((s) => s.voiced)) {
    // The larger face over the whole clip, not per sample: on a silent two-shot a per-sample choice flaps between two men
    // whose apparent size wobbles by a pixel. With one face the two rules are the same thing.
    const meanW = (k: 0 | 1) => { let sum = 0, n = 0; for (const s of ss) { const p = s.p[k]; if (p) { sum += p.w; n++; } } return n ? sum / n : 0; };
    const big: 0 | 1 = meanW(1) > meanW(0) ? 1 : 0; const other = (1 - big) as 0 | 1;
    const picks = ss.map((s) => (s.p[big] ? big : s.p[other] ? other : null));
    return { samples: ss.map((s, i) => at(s.t, picks[i] === null ? null : s.p[picks[i]!])), cutAt: [], switches: [], picks, bothFound, two: false };
  }
  const buf: { t: number; v: number }[][] = [[], []]; const mean = (b: { v: number }[]) => (b.length ? b.reduce((a, x) => a + x.v, 0) / b.length : 0);
  // Who to open on: the man who talks more in the first second of sound. The whole clip is looked at before the window is
  // drawn, so there is no reason to start on the bigger face and correct a moment later, in front of the person watching.
  const opener = ((): 0 | 1 | null => {
    let from = -1; const sum = [0, 0], n = [0, 0];
    for (const s of ss) { if (!s.voiced) continue; if (from < 0) from = s.t; if (s.t > from + o.win) break;
      for (const k of [0, 1] as const) { const p = s.p[k]; if (p) { sum[k]! += p.talk; n[k]!++; } } }
    return n[0]! && n[1]! ? (sum[1]! / n[1]! > sum[0]! / n[0]! ? 1 : 0) : null;
  })();
  const samples: Sample[] = [], cutAt: number[] = [], switches: number[] = [], picks: (0 | 1 | null)[] = [];
  let cur: 0 | 1 | null = null, lastSwitch = -Infinity, settled = Infinity; const lastSeen = [-Infinity, -Infinity];
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i]!;
    for (const k of [0, 1] as const) if (s.p[k]) lastSeen[k] = s.t;
    // talk counts only where there is sound: a silent mouth moving is chewing, laughing or a cutaway. Worth 7 points and one
    // spurious switch in the study. The buffer is a second long by time, so a man who is lost for a second scores nothing.
    if (s.voiced) { for (const k of [0, 1] as const) { const p = s.p[k]; if (p) buf[k]!.push({ t: s.t, v: p.talk }); } if (settled === Infinity) settled = s.t + o.win; }
    for (const k of [0, 1] as const) while (buf[k]!.length && buf[k]![0]!.t <= s.t - o.win) buf[k]!.shift();
    const score = [mean(buf[0]!), mean(buf[1]!)];
    if (cur === null) {
      // the opening choice: the man the first second of sound points at, or the bigger face when it points at neither
      cur = opener !== null && s.p[opener] ? opener : s.p[0] && s.p[1] ? (s.p[1]!.w > s.p[0]!.w ? 1 : 0) : s.p[0] ? 0 : s.p[1] ? 1 : null;
    } else {
      const other = (1 - cur) as 0 | 1;
      // The first second of sound is the opening choice being settled, not a speaker change: it may still cut the window
      // across, but the hold does not apply to it and nobody would call it a change, so it is not counted as one.
      const opening = s.t < settled;
      // While the man we follow is out of frame his mouth cannot be measured, so there is nothing to compare the other man
      // against: comparing anyway hands the window to a silent listener the moment a talker turns his head away (caught by
      // the lost-face test, 2026-09-19). Only a long absence moves it then, because by that point he really is gone.
      const beats = buf[cur]!.length ? score[other]! > score[cur]! * o.lead + o.margin : lastSeen[cur]! < s.t - o.lost;
      if (s.voiced && s.p[other] && beats && (opening || s.t - lastSwitch >= o.hold)) {
        cur = other; lastSwitch = s.t; cutAt.push(i); if (!opening) switches.push(+s.t.toFixed(2));
      }
    }
    // The chosen man stays chosen when he is not found in this sample: nothing is invented for him, and the track holds the
    // window where it is (and, after a long absence, eases back to the middle) exactly as it does for one face.
    const p = cur === null ? null : s.p[cur];
    picks.push(p ? cur : null); samples.push(at(s.t, p));
  }
  return { samples, cutAt, switches, picks, bothFound, two: true };
}

/**
 * Samples → track, with a cut where the speaker changed and the other man is outside the window.
 * The two faces in a two-shot sit about a window apart, so panning between them is a one-and-a-half-second slide across an
 * empty middle: the study's clip measured 0.30 to 0.31 apart against a window 0.3164 wide. Faces closer than half a window
 * are both inside it, so those pan as before. With no cuts this is smoothTrack, unchanged, which is what one face gets.
 */
export function buildTrack(samples: Sample[], cutAt: number[] = [], o = TRACK, windowWidth = windowFraction(16, 9)): Point[] {
  if (!samples.length) return [];
  const cuts = new Set(cutAt); const out: Point[] = []; let start = 0;
  while (start < samples.length) {
    const seg = smoothTrack(samples.slice(start), o); // each segment starts on its own first face, so the window is on the new man at once
    let end = seg.length;
    for (let k = 1; k < seg.length; k++) {
      const s = samples[start + k]!;
      if (s.x === null || s.x === undefined || !cuts.has(start + k)) continue;
      if (Math.abs(s.x - seg[k - 1]!.cx) > windowWidth / 2) { end = k; break; }
    }
    for (let k = 0; k < end; k++) out.push(start > 0 && k === 0 ? { ...seg[k]!, jump: 1 } : seg[k]!);
    start += end;
  }
  return out;
}

/** Output size for a source: full source height, 9:16, even numbers (encoders want them). */
export function outputSize(srcW: number, srcH: number, aspect = 9 / 16): { width: number; height: number } {
  const r = cropRect(0.5, 0.5, srcW, srcH, aspect); const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(r.sw), height: even(r.sh) };
}
