import { test, expect } from "bun:test";
import { smoothTrack, centreAt, cropRect, outputSize, pickSpeaker, buildTrack, windowFraction, SPEAK, type Person, type SpeakerSample } from "../src/lib/track";
import { assignFaces, lookPlan, voicedFrom, type Face, type Look } from "../src/lib/scan";
import { displayName, fitName, outputBase } from "../src/lib/naming";

const seen = (t: number, x: number, y = 0.5) => ({ t, x, y, w: 0.15 });
const none = (t: number) => ({ t, x: null as null });

// Two-person fixtures: the left man sits at 0.31, the right at 0.63 (the real clip of 2026-09-19), a quarter second apart.
// talk is mouth motion over eye motion: about 2 for the one talking, about 0.3 for the one listening.
const L = (talk: number, w = 0.085): Person => ({ cx: 0.31, cy: 0.24, w, talk });
const R = (talk: number, w = 0.085): Person => ({ cx: 0.63, cy: 0.24, w, talk });
/** A turn-taking clip: `turns` are [seconds, who talks (0 left, 1 right)], sampled every 0.25 s. */
function turns(list: [number, 0 | 1][], o: { voiced?: (t: number) => boolean; miss?: (t: number) => 0 | 1 | null } = {}): SpeakerSample[] {
  const out: SpeakerSample[] = []; const total = list.reduce((a, [s]) => a + s, 0);
  for (let t = 0, i = 0, used = 0; t < total - 1e-9; t += 0.25) {
    while (used + list[i]![0] <= t + 1e-9) { used += list[i]![0]; i++; }
    const who = list[i]![1]; const miss = o.miss?.(t) ?? null;
    out.push({ t: +t.toFixed(2), voiced: o.voiced ? o.voiced(t) : true, p: [miss === 0 ? null : L(who === 0 ? 2 : 0.3), miss === 1 ? null : R(who === 1 ? 2 : 0.3)] });
  }
  return out;
}
const oneSide = (ss: SpeakerSample[], k: 0 | 1) => ss.map((s) => ({ ...s, p: (k === 0 ? [s.p[0], null] : [null, s.p[1]]) as SpeakerSample["p"] }));

test("track: starts on the first face, ignores jitter, follows a real move within the pan limit", () => {
  const s = [seen(0, 0.3), seen(0.25, 0.31), seen(0.5, 0.29), seen(0.75, 0.3), seen(1, 0.7), seen(1.25, 0.7), seen(1.5, 0.7), seen(1.75, 0.7), seen(2, 0.7), seen(2.25, 0.7), seen(2.5, 0.7)];
  const tr = smoothTrack(s);
  expect(tr[0].cx).toBeCloseTo(0.3, 2); // no pan from the middle at the start
  expect(Math.abs(tr[3].cx - 0.3)).toBeLessThan(0.005); // 1 percent wobble is not a move
  for (let i = 1; i < tr.length; i++) expect(Math.abs(tr[i].cx - tr[i - 1].cx)).toBeLessThanOrEqual(0.35 * 0.25 + 1e-6); // never faster than the pan limit
  expect(tr[tr.length - 1].cx).toBeGreaterThan(0.66); // and it does arrive
});

test("track: a lost face holds, a long absence drifts back to the middle", () => {
  const s = [seen(0, 0.2), seen(0.5, 0.2), none(1), none(1.5), none(2), none(4), none(5), none(6), none(7)];
  const tr = smoothTrack(s);
  expect(tr[3].cx).toBeCloseTo(0.2, 2); // held for the first seconds
  expect(tr[tr.length - 1].cx).toBeGreaterThan(0.25); // then easing back
  expect(centreAt(tr, 0.25).cx).toBeCloseTo(0.2, 2); expect(centreAt(tr, 99).cx).toBe(tr[tr.length - 1].cx); expect(centreAt([], 3).cx).toBe(0.5);
});

test("crop: full-height 9:16 window kept inside the picture; narrow sources used whole", () => {
  expect(cropRect(0.5, 0.5, 1920, 1080)).toEqual({ sx: 656, sy: 0, sw: 608, sh: 1080 });
  expect(cropRect(0.02, 0.5, 1920, 1080).sx).toBe(0); expect(cropRect(0.99, 0.5, 1920, 1080).sx).toBe(1312);
  expect(cropRect(0.5, 0.5, 1080, 1920)).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1920 });
  expect(outputSize(1920, 1080)).toEqual({ width: 608, height: 1080 }); expect(outputSize(1280, 720)).toEqual({ width: 406, height: 720 });
});

test("speaker: clean turn-taking switches once per change, soon after it, and not more often", () => {
  const ss = turns([[7, 0], [7, 1], [7, 0], [7, 1]]);
  const r = pickSpeaker(ss);
  expect(r.two).toBe(true); expect(r.bothFound).toBe(1);
  expect(r.switches.length).toBe(3);
  for (const [i, change] of [7, 14, 21].entries()) { expect(r.switches[i]!).toBeGreaterThanOrEqual(change); expect(r.switches[i]! - change).toBeLessThanOrEqual(2); }
  for (let i = 1; i < r.switches.length; i++) expect(r.switches[i]! - r.switches[i - 1]!).toBeGreaterThanOrEqual(SPEAK.hold);
  // the target is the man who is talking, outside the one second after each change in which the evidence is still mixed
  const off = (t: number) => [7, 14, 21].some((c) => t >= c && t < c + 2);
  const wrong = r.samples.filter((s, i) => !off(s.t) && s.x !== null && Math.abs(s.x - (ss[i]!.p[0]!.talk > 1 ? 0.31 : 0.63)) > 0.01);
  expect(wrong.length).toBe(0);
});

test("speaker: the window opens on the man who is talking, not on the nearer face", () => {
  const ss = turns([[7, 0], [7, 1]]); for (const s of ss) s.p[1]!.w = 0.12; // the right man sits nearer the camera; the left man starts
  const r = pickSpeaker(ss);
  expect(r.samples[0]!.x).toBeCloseTo(0.31, 2); // the first frame is already on the right man, with no correction to watch
  expect(r.cutAt.length).toBe(1); expect(r.switches.length).toBe(1);
});

test("speaker: a laughing listener under the hold does not steal the window, and neither does both talking at once", () => {
  // the right man laughs for a second in the middle of the left man's turn: a real burst of mouth motion, but not more than the lead allows
  const ss = turns([[14, 0]]); for (const s of ss) if (s.t >= 5 && s.t < 6) s.p[1]!.talk = 2.5;
  expect(pickSpeaker(ss).switches).toEqual([]);
  const both = turns([[14, 0]]); for (const s of both) s.p[1]!.talk = 2; // both talking: the window holds the side it is on
  expect(pickSpeaker(both).switches).toEqual([]);
});

test("speaker: silence does not switch, and a change is only taken once the sound comes back", () => {
  // the left man talks, then the clip goes quiet while the right man's mouth moves (a cutaway, a cough, an edit)
  const ss = turns([[6, 0], [6, 1]], { voiced: (t) => t < 6 || t >= 9 });
  const r = pickSpeaker(ss);
  expect(r.switches.filter((t) => t >= 6 && t < 9)).toEqual([]);
  expect(r.switches.length).toBe(1); expect(r.switches[0]!).toBeGreaterThanOrEqual(9);
});

test("speaker: a lost face holds the window and does not freeze the other man out", () => {
  // the right man is not found between 8 and 10 s, in the middle of his own turn: the window stays where it is (no position, so the track holds)
  const ss = turns([[7, 0], [7, 1]], { miss: (t) => (t >= 8 && t < 10 ? 1 : null) });
  const r = pickSpeaker(ss);
  const gap = r.samples.filter((s) => s.t >= 8 && s.t < 10);
  expect(gap.every((s) => s.x === null)).toBe(true); // nothing invented while he is missing
  expect(r.samples.find((s) => s.t === 10.25)!.x).toBeCloseTo(0.63, 2); // and he is still the target when he comes back
  expect(r.switches.length).toBe(1); // a face lost for two seconds is not a speaker change
  // but a man who stays out of frame does not hold the window hostage: after SPEAK.lost the window goes to the one who is there
  const gone = turns([[4, 0], [10, 1]], { miss: (t) => (t >= 8 ? 1 : null) });
  const g = pickSpeaker(gone);
  expect(g.switches.length).toBe(2); expect(g.switches[1]!).toBeGreaterThanOrEqual(8 + SPEAK.lost); expect(g.switches[1]!).toBeLessThan(8 + SPEAK.lost + 0.5);
  expect(g.samples[g.samples.length - 1]!.x).toBeCloseTo(0.31, 2);
});

test("speaker: one face, or a second face in too few samples, gives exactly today's track", () => {
  const ss = turns([[7, 0], [7, 1]]);
  const solo = pickSpeaker(oneSide(ss, 0));
  expect(solo.two).toBe(false); expect(solo.switches).toEqual([]); expect(solo.cutAt).toEqual([]);
  const rare = oneSide(ss, 0).map((s, i) => (i % 10 === 0 ? { ...s, p: [s.p[0], R(2)] as SpeakerSample["p"] } : s)); // the second man shows up in 10% of the samples
  expect(pickSpeaker(rare).two).toBe(false);
  // and the old expectations still hold, end to end, through the new builder
  const s = [seen(0, 0.3), seen(0.25, 0.31), seen(0.5, 0.29), seen(0.75, 0.3), seen(1, 0.7), seen(1.25, 0.7), seen(1.5, 0.7), seen(1.75, 0.7), seen(2, 0.7), seen(2.25, 0.7), seen(2.5, 0.7)];
  const tr = buildTrack(s, []);
  expect(tr).toEqual(smoothTrack(s));
  expect(tr[0]!.cx).toBeCloseTo(0.3, 2); expect(Math.abs(tr[3]!.cx - 0.3)).toBeLessThan(0.005);
  for (let i = 1; i < tr.length; i++) expect(Math.abs(tr[i]!.cx - tr[i - 1]!.cx)).toBeLessThanOrEqual(0.35 * 0.25 + 1e-6);
  expect(tr[tr.length - 1]!.cx).toBeGreaterThan(0.66);
  const lost = [seen(0, 0.2), seen(0.5, 0.2), none(1), none(1.5), none(2), none(4), none(5), none(6), none(7)];
  expect(buildTrack(lost, [])).toEqual(smoothTrack(lost));
});

test("speaker: a clip with no sound follows the larger face and keeps moving", () => {
  const ss = turns([[7, 0], [7, 1]], { voiced: () => false });
  for (const s of ss) s.p[1]!.w = 0.11; // the right man is nearer the camera
  const r = pickSpeaker(ss);
  expect(r.two).toBe(false); expect(r.switches).toEqual([]);
  expect(r.samples.every((s) => s.x !== null && Math.abs(s.x - 0.63) < 0.01)).toBe(true); // one side, held, not the middle and not frozen at t = 0
  expect(buildTrack(r.samples, r.cutAt).length).toBe(ss.length);
});

test("track: a speaker change is a cut, a face that merely moves is a pan", () => {
  const ss = turns([[7, 0], [7, 1]]); const r = pickSpeaker(ss);
  const w = windowFraction(1280, 720); expect(w).toBeCloseTo(0.3164, 3);
  const tr = buildTrack(r.samples, r.cutAt, undefined, w);
  const jumps = tr.filter((p) => p.jump); expect(jumps.length).toBe(1);
  const j = tr.findIndex((p) => p.jump);
  expect(Math.abs(tr[j]!.cx - tr[j - 1]!.cx)).toBeGreaterThan(0.25); // the whole way across in one step: the window does not slide past the empty middle
  expect(centreAt(tr, tr[j]!.t - 0.01).cx).toBeCloseTo(tr[j - 1]!.cx, 4); // and no half-way frames: a cut is a cut in the preview and in the saved file
  expect(centreAt(tr, tr[j]!.t).cx).toBeCloseTo(tr[j]!.cx, 4);
  // two faces closer together than half a window: the window covers both, so it pans instead of cutting
  const near = r.samples.map((s) => (s.x === null ? s : { ...s, x: s.x > 0.5 ? 0.42 : 0.31 }));
  expect(buildTrack(near, r.cutAt, undefined, w).filter((p) => p.jump).length).toBe(0);
});

// ---- reading the clip: where to look, who is who, what counts as sound (code review, 2026-09-19) ----
const face = (x: number, score = 0.9, w = 0.085): Face => ({ x, y: 0.24, w, h: 0.15, score, mouth: { x, y: 0.29 }, eyes: { x, y: 0.21 } });
const wide = (looks: Look[]) => looks.some((l) => l.cx !== looks[0]!.cx && l.cy !== looks[0]!.cy) && looks.length > 4; // a search over the whole frame, not two windows in one place

test("look plan: a lost man is searched over the whole frame again; the one nobody is following, every fourth sample", () => {
  const alone: [Face | null, Face | null] = [face(0.3), null];
  // the only man in the clip: where he was, wider window first, then the whole frame if that comes back empty — what the
  // tool did before two people existed, and what keeps the one-face fixture at every sample found
  for (const [i, lost] of [[5, 1], [9, 5]] as const) {
    const looks = lookPlan({ i, seconds: i * 0.25, prev: alone, lostFor: [lost, 99], combined: false }).slots[0];
    expect(looks.slice(0, 2).map((l) => l.zoom)).toEqual([2, 3]); expect(wide(looks)).toBe(true);
  }
  // with the other man on screen the window has somewhere to stay, so this one is looked for every fourth sample
  const pair: [Face | null, Face | null] = [face(0.3), face(0.63)];
  expect(lookPlan({ i: 9, seconds: 2.25, prev: pair, lostFor: [5, 0], combined: false }).slots[0]).toEqual([]);
  expect(wide(lookPlan({ i: 8, seconds: 2, prev: pair, lostFor: [4, 0], combined: false }).slots[0])).toBe(true);
  expect(wide(lookPlan({ i: 5, seconds: 1.25, prev: pair, lostFor: [1, 0], combined: false }).slots[0])).toBe(false); // gone one sample: try where he was before searching the frame
});

test("look plan: hunting for a second person costs little on a clip that has one", () => {
  const prev: [Face | null, Face | null] = [face(0.3), null];
  const early = (i: number) => lookPlan({ i, seconds: i * 0.25, prev, lostFor: [0, 99], combined: false }).slots[1].length;
  expect(early(4)).toBe(2); expect(early(5)).toBe(0); // every fourth sample while the clip is young
  const late = (i: number) => lookPlan({ i, seconds: i * 0.25, prev, lostFor: [0, 99], combined: false }).slots[1].length;
  expect(late(24)).toBe(0); expect(late(40)).toBe(2); // and rarely after that: five seconds in, a second man is unlikely
  expect(lookPlan({ i: 7, seconds: 1.75, prev: [face(0.3), face(0.63)], lostFor: [0, 0], combined: true }).combined).toBeTruthy(); // both in one window when they fit
});

test("faces: a slot keeps its man, and a third face does not swap it", () => {
  const prev: [Face | null, Face | null] = [face(0.31), face(0.63)];
  const third = assignFaces([face(0.47, 0.95, 0.12), face(0.31), face(0.63)], prev); // a bigger face walks between them
  expect(third.faces).toBe(3);
  expect(third.pair[0]!.x).toBeCloseTo(0.31, 2); expect(third.pair[1]!.x).toBeCloseTo(0.63, 2); // the two we were following, not the two biggest
  const drift = assignFaces([face(0.35), face(0.60)], prev); // both moved a little
  expect(drift.pair[0]!.x).toBeCloseTo(0.35, 2); expect(drift.pair[1]!.x).toBeCloseTo(0.60, 2);
  const close = assignFaces([face(0.44), face(0.50)], [face(0.43), face(0.51)]); // two people standing close together
  expect(close.pair[0]!.x).toBeCloseTo(0.44, 2); expect(close.pair[1]!.x).toBeCloseTo(0.50, 2);
  const one = assignFaces([face(0.63)], prev); // only the right man found this sample
  expect(one.pair[0]).toBe(null); expect(one.pair[1]!.x).toBeCloseTo(0.63, 2);
  const back = assignFaces([face(0.31), face(0.66)], [face(0.31), face(0.63)]); // and he comes back to his own slot
  expect(back.pair[1]!.x).toBeCloseTo(0.66, 2);
  expect(assignFaces([face(0.3), face(0.7, 0.52)], [null, null]).pair[1]).toBe(null); // a barely detected second face is not a second person
  expect(assignFaces([face(0.3), face(0.31)], [null, null]).faces).toBe(1); // one face through two windows is one face
});

test("sound: the level to beat follows the clip, so a quiet recording still has a voice in it", () => {
  const speech = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 0.004 : 0.2)); // a loud clip with a silent beat
  expect(voicedFrom(speech).filter(Boolean).length).toBe(30);
  const quiet = speech.map((v) => v * 0.2); // the same clip recorded quietly: 0.04 of speech, under the old fixed 0.02 floor for the beats
  const heard = voicedFrom(quiet);
  expect(heard.filter(Boolean).length).toBe(30); expect(heard[0]).toBe(false);
  const hiss = Array.from({ length: 40 }, (_, i) => (i < 20 ? 0.03 : 0.3)); // room tone under half the clip, talking over the rest
  expect(voicedFrom(hiss).slice(0, 20).some(Boolean)).toBe(false); // the hiss is not talking
  expect(voicedFrom(hiss).slice(20).every(Boolean)).toBe(true);
});

test("speaker: a room of people gets the one-face pan, not a window flapping between two of them", () => {
  const ss = turns([[7, 0], [7, 1]]).map((s, i) => ({ ...s, n: i >= 4 ? 3 : 2 })); // a third face from the second second on
  expect(pickSpeaker(ss).two).toBe(false);
  expect(pickSpeaker(turns([[7, 0], [7, 1]]).map((s) => ({ ...s, n: 2 }))).two).toBe(true);
});

test("naming: kept from captions, shortened in the middle when needed", () => {
  expect(outputBase("Podcast ep 12.mov")).toBe("Podcast ep 12"); expect(displayName("short.mp4")).toBe("short.mp4");
  expect(fitName("A very long podcast episode name that goes on-vertical.mp4", (t) => t.length <= 28).endsWith("-vertical.mp4")).toBe(true);
});
