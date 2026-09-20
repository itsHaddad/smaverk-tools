// scan.ts: the parts of reading a clip that can be decided without a browser — where to look next, which face is whose,
// how much a mouth moved between two frames, and which quarter-seconds have a voice in them. detect.ts does the canvas and
// model work and calls in here for every decision, so each one can be tested on its own (code review, 2026-09-19: the
// search strategy had lost its fall-through to a whole-frame look and nothing could have caught it).

export type Pt = { x: number; y: number };
export type Face = { x: number; y: number; w: number; h: number; score: number; mouth: Pt; eyes: Pt }; // all fractions of the frame
export type Look = { cx: number; cy: number; zoom: number; g: number }; // a window to run the model on; g groups looks that are run together
export const FIND = {
  identity: 0.08, // a face this close to where a man was is that man
  same: 0.05, // two boxes this close are one face seen through two windows
  secondFace: 0.6, // how sure the model must be about a second person before the window is allowed to cut between two
  lostSoon: 2, // samples: after this a missing man is searched wide, not just where he was
  every: 4, // ...and only this often, the cost rule of the study
  newEarly: 4, newLate: 20, earlySeconds: 5, // a man never seen yet: often at first (a two-shot shows both from the start), rarely after
  voiceFloor: 0.02, voiceShare: 0.25, // sound: the floor, and the share of a loud quarter-second that still counts as voiced
};

/** The same face can come back from two overlapping windows; keep the most certain copy of each. */
export function dedupe(found: Face[]): Face[] {
  const out: Face[] = [];
  for (const f of [...found].sort((a, b) => b.w * b.score - a.w * a.score)) if (!out.some((u) => Math.abs(u.x - f.x) < FIND.same)) out.push(f);
  return out;
}

const grid = (zoom: number, g: number): Look[] => { const n = zoom + 1, out: Look[] = []; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push({ cx: (i + 0.5) / n, cy: (j + 0.5) / n, zoom, g }); return out; };

/**
 * Where to point the model this sample, cheapest first. detect.ts runs the looks of one group, and stops at the first
 * group that finds a face. `combined` is the one window that may hold both men at once, worth half the calls when it works.
 */
export function lookPlan(st: { i: number; seconds: number; prev: [Face | null, Face | null]; lostFor: [number, number]; combined: boolean }): { combined: Look | null; slots: [Look[], Look[]] } {
  const [l, r] = st.prev; const slots: [Look[], Look[]] = [[], []]; let both: Look | null = null;
  if (l && r && st.combined && st.lostFor[0] === 0 && st.lostFor[1] === 0) {
    const span = Math.abs(r.x - l.x) + Math.max(l.w, r.w) * 1.6, zoom = Math.min(2.5, 1 / span);
    if (zoom >= 1.8) both = { cx: (l.x + r.x) / 2, cy: (l.y + r.y) / 2, zoom, g: 0 };
  }
  for (const k of [0, 1] as const) {
    const p = st.prev[k], lost = st.lostFor[k]!, other = st.prev[1 - k];
    // Is there somebody else on screen right now? If there is, the window has someone to stay on while this man is missing,
    // so he is searched for sparingly. If there is not, he is the clip, and the search is the one the tool has always run.
    const following = !!other && st.lostFor[1 - k]! < FIND.lostSoon;
    if (p) {
      if (lost >= FIND.lostSoon && following && st.i % FIND.every !== 0) continue; // the cost rule of the study, for the man who is not the one being followed
      slots[k]!.push({ cx: p.x, cy: p.y, zoom: 2, g: 0 }, { cx: p.x, cy: p.y, zoom: 3, g: 1 }); // the window he was in, then a tighter one: the order the tool has always used
      // and when those come back empty, the whole frame: he may have walked across it, or the shot may have changed. Before
      // 2026-09-19 this fall-through was the only search there was; dropping it lost a man who left and came back elsewhere
      // for the rest of the clip, and cost the one-face fixture five points of the samples it used to find (2026-09-19).
      if (!following || lost >= FIND.lostSoon) slots[k]!.push(...grid(2, 2), ...grid(3, 3));
      continue;
    }
    if (!(st.seconds < FIND.earlySeconds ? st.i % FIND.newEarly === 0 : st.i % FIND.newLate === 0)) continue;
    if (other) { const cx = other.x < 0.5 ? 0.75 : 0.25; slots[k]!.push({ cx: cx - 1 / 6, cy: other.y, zoom: 3, g: 0 }, { cx: cx + 1 / 6, cy: other.y, zoom: 3, g: 0 }); } // his half of the frame, level with the other man: a two-shot puts them level
    else if (k === 0) slots[k]!.push(...grid(2, 0), ...grid(3, 1)); // nobody at all: the whole frame, once for both slots
  }
  return { combined: both, slots };
}

/**
 * This sample's faces sorted into the left and the right man. A slot keeps its man by where he was, not by re-sorting the
 * faces by x every sample: with a third face in shot, re-sorting silently swapped who slot 1 meant and the window shook
 * (code review, 2026-09-19). `faces` is how many people were really there, which is how a crowd is noticed.
 */
export function assignFaces(found: Face[], prev: [Face | null, Face | null]): { pair: [Face | null, Face | null]; faces: number } {
  const uniq = dedupe(found); const pair: [Face | null, Face | null] = [null, null]; const used = new Set<Face>();
  const claims: { k: 0 | 1; f: Face; d: number }[] = [];
  for (const k of [0, 1] as const) { const p = prev[k]; if (!p) continue; for (const f of uniq) { const d = Math.abs(f.x - p.x); if (d < FIND.identity) claims.push({ k, f, d }); } }
  for (const c of claims.sort((a, b) => a.d - b.d)) if (!pair[c.k] && !used.has(c.f)) { pair[c.k] = c.f; used.add(c.f); } // nearest first, so each man keeps his slot
  for (const f of uniq) {
    if (used.has(f) || (pair[0] && pair[1])) continue;
    const taken = pair[0] ? 0 : pair[1] ? 1 : null;
    if (taken !== null) { // he would make this a two-person shot, so he has to be more than barely detected
      if (f.score < FIND.secondFace) continue;
      // he is further from the other man than the identity rule allows, so he is somebody else: the free slot is his,
      // whichever side he stands on. detect.ts names the two left and right once, when it first has a pair.
      pair[1 - taken] = f; used.add(f); continue;
    }
    const known = prev[0] && prev[1] ? null : prev[0] ? 0 : prev[1] ? 1 : null;
    if (known !== null) { pair[known] = f; used.add(f); continue; } // one man known and this is not him where he was: the same man, moved
    const k: 0 | 1 = prev[0] && prev[1] ? (f.x < (prev[0]!.x + prev[1]!.x) / 2 ? 0 : 1) : 0; // both known but he is near neither: the side he is on
    pair[k] = f; used.add(f);
  }
  return { pair, faces: uniq.length };
}

/** Motion inside one box between the two frames of a pair, as a mean grey-level difference (0 to 255) on the small canvas. */
export function moved(a: Uint8ClampedArray, b: Uint8ClampedArray, gw: number, gh: number, c: Pt, halfW: number, halfH: number): number {
  const x0 = Math.max(0, Math.round((c.x - halfW) * gw)), x1 = Math.min(gw, Math.round((c.x + halfW) * gw));
  const y0 = Math.max(0, Math.round((c.y - halfH) * gh)), y1 = Math.min(gh, Math.round((c.y + halfH) * gh));
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * gw + x) * 4; // grey by the usual weights, on both frames at once: no second buffer to fill
    sum += Math.abs(((a[i]! * 77 + a[i + 1]! * 150 + a[i + 2]! * 29) >> 8) - ((b[i]! * 77 + b[i + 1]! * 150 + b[i + 2]! * 29) >> 8)); n++;
  }
  return n ? sum / n : 0;
}

/** How much this face's mouth moved compared with the rest of it. About 2 for the man talking, about 0.3 for the one listening. */
export function talkScore(f: Face, a: Uint8ClampedArray | null, b: Uint8ClampedArray | null, gw: number, gh: number): number {
  if (!a || !b) return 0; // no second frame (the end of the clip, or one the decoder could not give): no evidence either way
  const mouth = moved(a, b, gw, gh, f.mouth, f.w * 0.30, f.h * 0.20);
  const eyes = moved(a, b, gw, gh, f.eyes, f.w * 0.42, f.h * 0.15);
  return mouth / (eyes + 0.5); // the floor keeps a still frame from dividing by nothing; eye motion is what a turning head has too
}

/**
 * Which quarter-seconds have a voice in them, from their sound levels.
 * The threshold is a quarter of a loud moment in this clip, never below the absolute floor: a quiet recording used to come
 * out as pure silence, which turned the whole feature off without saying so, and a room-tone hiss used to count as talking
 * (code review, 2026-09-19).
 */
export function voicedFrom(rms: number[], o = FIND): boolean[] {
  const loud = [...rms].filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = loud.length ? loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.9))]! : 0;
  const level = Math.max(o.voiceFloor, p90 * o.voiceShare);
  return rms.map((v) => v > level);
}
