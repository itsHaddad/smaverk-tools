import { test, expect } from "bun:test";
import { MAX_CLIP_S, MIN_CLIP_S, DEFAULT_KEEP, planMoments, capEnd, trimTo, trimBounds, sentenceEnd, alignToZero, clipName, mayFreeSave, keptCount, madeLine } from "../src/lib/plan";

const m = (startS: number, endS: number, opening = "So what happened next?") => ({ startS, endS, why: ["Opens on the question it answers"], opening });

// --- the list the person starts from ---------------------------------------------------------------

test("the strongest three are kept by default, and the rest are offered unticked", () => {
  const list = planMoments([m(10, 70), m(200, 250), m(400, 460), m(600, 650), m(800, 850)]);
  expect(DEFAULT_KEEP).toBe(3);
  expect(list.map((x) => x.keep)).toEqual([true, true, true, false, false]);
  expect(keptCount(list)).toBe(3);
});

test("fewer moments than the default keeps all of them", () => {
  expect(planMoments([m(10, 70)]).map((x) => x.keep)).toEqual([true]);
  expect(planMoments([])).toEqual([]);
});

test("a moment longer than the cap is cut to the cap from its own start, and says so", () => {
  expect(MAX_CLIP_S).toBe(90);
  const [a, b] = planMoments([m(100, 250), m(400, 460)]);
  expect(a!.startS).toBe(100);
  expect(a!.endS).toBe(100 + MAX_CLIP_S);
  expect(a!.capped).toBe(true);
  expect(a!.foundEndS).toBe(250); // what the finder said is kept, so the page can say it was cut
  expect(b!.capped).toBe(false);
  expect(b!.endS).toBe(460);
});

test("the cap itself: only lengths over it move", () => {
  expect(capEnd(0, 60)).toEqual({ endS: 60, capped: false });
  expect(capEnd(0, 90)).toEqual({ endS: 90, capped: false });
  expect(capEnd(5, 95.5)).toEqual({ endS: 95, capped: true });
});

// --- trimming ---------------------------------------------------------------------------------------

test("trimming keeps a clip between the shortest and the longest the tool makes", () => {
  expect(trimTo(100, 300, 1000)).toEqual({ startS: 100, endS: 100 + MAX_CLIP_S });
  expect(trimTo(100, 105, 1000)).toEqual({ startS: 100, endS: 100 + MIN_CLIP_S });
  expect(trimTo(-5, 40, 1000)).toEqual({ startS: 0, endS: 40 });
  // Near the end of the recording the start gives way, not the length.
  expect(trimTo(990, 1000, 1000)).toEqual({ startS: 1000 - MIN_CLIP_S, endS: 1000 });
});

test("the trim handles reach two minutes each way but never past the recording or the cap", () => {
  const b = trimBounds({ startS: 300, endS: 360 }, 1000);
  expect(b.start).toEqual({ min: 180, max: 340 });
  expect(b.end).toEqual({ min: 320, max: 390 });
  const edge = trimBounds({ startS: 30, endS: 80 }, 100);
  expect(edge.start.min).toBe(0);
  expect(edge.end.max).toBe(100);
});

// --- the end of a clip that was cut to the cap ------------------------------------------------------

const w = (text: string, start: number) => ({ text, start, end: start + 0.4 });

test("a clip cut to the cap ends on the last finished sentence before it", () => {
  const words = [w("We", 1), w("went", 2), w("up.", 3), w("Then", 40), w("it", 41), w("stopped.", 60), w("And", 80), w("then", 89.5)];
  expect(sentenceEnd(words, 90)).toBeCloseTo(60.4 + 0.3, 5);
});

test("with no finished sentence after the shortest length, the cap stands", () => {
  const words = [w("We", 1), w("went", 2), w("up.", 3), w("and", 50), w("on", 80)];
  expect(sentenceEnd(words, 90)).toBe(90);
  expect(sentenceEnd([], 90)).toBe(90);
});

test("the end is never past the cap, even with the tail after the last word", () => {
  expect(sentenceEnd([w("Done.", 89.8)], 90)).toBe(90);
});

test("an abbreviation is not the end of a sentence", () => {
  const words = [w("Ask", 30), w("Dr.", 50), w("Smith", 60), w("about", 70)];
  expect(sentenceEnd(words, 90)).toBe(90);
});

// --- the sound of a clip, on the clip's own clock ----------------------------------------------------

test("sound that starts before zero loses the part before zero", () => {
  const s = Float32Array.from({ length: 32000 }, (_, i) => i);
  const out = alignToZero(s, -0.5, 16000);
  expect(out.length).toBe(24000);
  expect(out[0]).toBe(8000);
});

test("sound that starts after zero is padded with silence to start at zero", () => {
  const s = new Float32Array(16000).fill(1);
  const out = alignToZero(s, 0.25, 16000);
  expect(out.length).toBe(20000);
  expect(out[0]).toBe(0);
  expect(out[4000]).toBe(1);
});

test("sound that starts at zero is handed back as it is", () => {
  const s = new Float32Array(10);
  expect(alignToZero(s, 0, 16000)).toBe(s);
});

// --- names, saving, and what the page says ------------------------------------------------------------

test("a saved clip is named after the recording, its place in the list and where it starts", () => {
  expect(clipName("My podcast episode 12.mp4", 1, 305.6)).toBe("My-podcast-episode-12-01-at-5-06.mp4");
  expect(clipName("interview.mov", 3, 3725)).toBe("interview-03-at-1-02-05.mp4");
});

test("the free version saves one clip; the paid version saves every clip", () => {
  expect(mayFreeSave(false, 0)).toBe(true);
  expect(mayFreeSave(false, 1)).toBe(false);
  expect(mayFreeSave(true, 7)).toBe(true);
});

test("the line under a finished clip says its length and where it came from", () => {
  expect(madeLine(56.4, 305.6, false)).toBe("56 s from 5:06.");
  expect(madeLine(90, 100, true)).toBe("1 min 30 s from 1:40. Cut to 90 seconds.");
});
