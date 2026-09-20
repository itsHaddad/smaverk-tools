import { test, expect } from "bun:test";
import { SilenceFinder } from "../src/lib/silence";
import { snap } from "../src/lib/pause";

const RATE = 16000;

/** Sound at `level`, then nothing, then sound again — the shape of a speaker taking a breath. */
function pattern(spans: { s: number; level: number }[]): Float32Array {
  const total = spans.reduce((n, x) => n + Math.round(x.s * RATE), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const { s, level } of spans) {
    const n = Math.round(s * RATE);
    for (let i = 0; i < n; i++) out[at + i] = level * Math.sin((2 * Math.PI * 180 * (at + i)) / RATE);
    at += n;
  }
  return out;
}

test("a gap in the sound is found where the talking starts again", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 2, level: 0.3 }, { s: 1.5, level: 0 }, { s: 2, level: 0.3 }]), 0);
  expect(f.silences).toHaveLength(1);
  expect(f.silences[0]!.at).toBeCloseTo(3.5, 1);
  expect(f.silences[0]!.lengthS).toBeCloseTo(1.5, 1);
});

test("a breath is not a break", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 1, level: 0.3 }, { s: 0.25, level: 0 }, { s: 1, level: 0.3 }]), 0);
  expect(f.silences).toHaveLength(0);
});

test("a quiet recording and a loud one give the same answer", () => {
  const spans = [{ s: 1.5, level: 1 }, { s: 1, level: 0 }, { s: 1.5, level: 1 }];
  const loud = new SilenceFinder(RATE);
  loud.feed(pattern(spans), 0);
  const quiet = new SilenceFinder(RATE);
  quiet.feed(pattern(spans.map((x) => ({ ...x, level: x.level * 0.02 }))), 0);
  expect(quiet.silences.map((s) => s.at)).toEqual(loud.silences.map((s) => s.at));
});

test("room tone under the talking is still silence", () => {
  // Real rooms are never at zero. A gap two per cent of speech level must still read as a gap.
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 1.5, level: 0.4 }, { s: 1, level: 0.004 }, { s: 1.5, level: 0.4 }]), 0);
  expect(f.silences).toHaveLength(1);
});

test("one loud bang does not raise the bar for the whole window", () => {
  const samples = pattern([{ s: 3, level: 0.2 }, { s: 1, level: 0 }, { s: 3, level: 0.2 }]);
  samples[Math.round(0.5 * RATE)] = 1; // a door slam
  const f = new SilenceFinder(RATE);
  f.feed(samples, 0);
  expect(f.silences).toHaveLength(1);
});

test("a silence that crosses a window boundary is one silence, not two", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 1, level: 0.3 }, { s: 1, level: 0 }]), 0);
  expect(f.silences).toHaveLength(0); // still running when the window ended
  f.feed(pattern([{ s: 1, level: 0 }, { s: 1, level: 0.3 }]), 2);
  expect(f.silences).toHaveLength(1);
  expect(f.silences[0]!.at).toBeCloseTo(3, 1);
  expect(f.silences[0]!.lengthS).toBeCloseTo(2, 1);
});

test("a recording that ends in silence closes its last run", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 1, level: 0.3 }, { s: 2, level: 0 }]), 0);
  expect(f.silences).toHaveLength(0);
  f.end(3);
  expect(f.silences).toHaveLength(1);
});

test("sound the window before already covered is not measured twice", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 2, level: 0.3 }, { s: 1, level: 0 }, { s: 1, level: 0.3 }]), 0);
  const before = f.silences.length;
  // The next window repeats its last second and is only authoritative from 4 s on.
  f.feed(pattern([{ s: 1, level: 0.3 }, { s: 1, level: 0 }, { s: 1, level: 0.3 }]), 3, 4);
  expect(f.silences.length).toBe(before + 1);
  expect(f.silences.every((s, i, all) => i === 0 || s.at > all[i - 1]!.at)).toBe(true);
});

test("silences are the shape a boundary snaps to", () => {
  const f = new SilenceFinder(RATE);
  f.feed(pattern([{ s: 2, level: 0.3 }, { s: 1, level: 0 }, { s: 2, level: 0.3 }]), 0);
  expect(snap(3.9, f.silences, 1).snapped).toBe(true);
  expect(snap(3.9, f.silences, 1).at).toBeCloseTo(3, 1);
  expect(snap(30, f.silences, 1).snapped).toBe(false);
});

test("a window with nothing in it does not throw and produces no silence until it ends", () => {
  const f = new SilenceFinder(RATE);
  f.feed(new Float32Array(0), 0);
  expect(f.silences).toHaveLength(0);
  f.feed(new Float32Array(Math.round(0.01 * RATE)), 0);
  expect(f.silences).toHaveLength(0);
});
