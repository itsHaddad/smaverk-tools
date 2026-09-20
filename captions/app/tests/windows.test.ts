import { test, expect } from "bun:test";
import { planWindows, keepWindowWords } from "../src/lib/windows";

test("windows: fewest 30 s passes, spread evenly, last one ends at the end", () => {
  expect(planWindows(12)).toEqual([{ start: 0, end: 12, keepFrom: 0, keepTo: Infinity }]);
  expect(planWindows(30)).toHaveLength(1);
  const w = planWindows(44);
  expect(w.map((x) => [x.start, x.end])).toEqual([[0, 30], [14, 44]]);
  expect(w[0].keepTo).toBe(22); expect(w[1].keepFrom).toBe(22);
  expect(planWindows(60).map((x) => [x.start, x.end])).toEqual([[0, 30], [30, 60]]); // the free limit: two passes
  expect(planWindows(61)).toHaveLength(3);
  const long = planWindows(300);
  expect(long).toHaveLength(10); // the paid limit: ten passes
  expect(long[0]).toEqual({ start: 0, end: 30, keepFrom: 0, keepTo: 30 });
  expect(long[long.length - 1]).toEqual({ start: 270, end: 300, keepFrom: 270, keepTo: Infinity });
  for (let i = 1; i < long.length; i++) { expect(long[i].start).toBeLessThanOrEqual(long[i - 1].end); expect(long[i].keepFrom).toBe(long[i - 1].keepTo); }
});

test("windows: each window keeps only its share, timestamps become absolute", () => {
  const [a, b] = planWindows(44);
  const heardA = [{ text: "one", start: 0.2, end: 0.5 }, { text: "edge", start: 21.9, end: 22.3 }, { text: "late", start: 22.4, end: 22.8 }, { text: "cut", start: 29.8, end: 30 }];
  expect(keepWindowWords(heardA, a).map((w) => w.text)).toEqual(["one", "edge"]);
  const heardB = [{ text: "early", start: 7.5, end: 7.9 }, { text: "late", start: 8.4, end: 8.8 }, { text: "end", start: 29.7, end: 30.4 }];
  const kept = keepWindowWords(heardB, b);
  expect(kept.map((w) => w.text)).toEqual(["late", "end"]);
  expect(kept[0].start).toBe(22.4); expect(kept[1].end).toBe(44); // clamped to the clip
});

import { earlier, LEAD } from "../src/lib/windows";
test("words are moved earlier by the measured lag, never before the start, order kept", () => {
  const w = earlier([{ text: "If", start: 0.1, end: 0.3 }, { text: "you", start: 0.42, end: 0.6 }, { text: "go", start: 5, end: 5.4 }]);
  expect(LEAD).toBe(0.2);
  expect(w[0]).toEqual({ text: "If", start: 0, end: 0.1 }); expect(w[1]).toEqual({ text: "you", start: 0.22, end: 0.4 }); expect(w[2]).toEqual({ text: "go", start: 4.8, end: 5.2 });
  for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBeGreaterThanOrEqual(w[i - 1]!.start);
  expect(earlier([{ text: "a", start: 0.05, end: 0.1 }])[0]!.end).toBeGreaterThan(0);
});
