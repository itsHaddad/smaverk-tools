import { test, expect } from "bun:test";
import { buildLines, lineAt, type Word } from "../src/lib/lines";
import { outputBase, outputName, displayName, fitName } from "../src/lib/naming";
import { toMono16k, estimateFactor } from "../src/lib/audio";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

test("lines: a long run is split into even parts and held until the next line starts", () => {
  const words = Array.from({ length: 7 }, (_, i) => w("w" + i, i * 0.4, i * 0.4 + 0.3));
  const lines = buildLines(words);
  expect(lines.map((l) => l.ws.length)).toEqual([3, 4]); // even parts, not five and a leftover two
  expect(lineAt(lines, 0.1)?.ws.map((x) => x.text)).toEqual(["w0", "w1", "w2"]);
  expect(lineAt(lines, 1.15)?.ws[0].text).toBe("w0"); // still the first line right before the second starts
  expect(lineAt(lines, 1.3)?.ws[0].text).toBe("w3");
  expect(lineAt(lines, 0.5)?.cur).toBe(1); // spoken word index inside the line
});

// Captioning practice (the principal, 2026-09-18: "how many words and the kind of words shown is proper").
const say = (s: string, pace = 0.32): Word[] => { let t = 0.5; return s.split(" ").map((x) => { const word = w(x, t, t + pace * 0.85); t += pace + (/[.!?]$/.test(x) ? 0.25 : 0); return word; }); };
const text = (s: string) => buildLines(say(s)).map((l) => l.ws.map((x) => x.text).join(" "));
const WEAK_END = /\b(a|an|the|to|of|in|on|at|for|with|and|or|but|your|my|is|are|can|very|just)$/i;

test("lines: the sample reads as phrases", () => {
  expect(text("Quick tip, you can add captions to a clip right here in your browser, and nothing gets uploaded. Pick a style, save the video. Done."))
    .toEqual(["Quick tip,", "you can add captions", "to a clip", "right here in your browser,", "and nothing gets uploaded.", "Pick a style,", "save the video.", "Done."]);
});
test("lines: a negation stays with what it negates", () => {
  for (const s of ["We checked twice and nothing gets uploaded to any server at all.", "Honestly that doesn't happen overnight for most people I know.", "You should not share the key with other people online."])
    for (const l of text(s)) expect(l).not.toMatch(/^(gets uploaded|happen overnight|share the key)\b/i);
});
test("lines: no line ends on a word that belongs to the next, none has one stranded word, all fit", () => {
  const talks = ["So the thing nobody tells you about starting a podcast is that the first ten episodes are for you, not for the audience.",
    "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
    "First, open the settings and turn on the new editor. Then pick the clip you want to use, and don't forget to save it before you close the app."];
  for (const s of talks) { const lines = text(s); const sentenceEnds = s.split(/(?<=[.!?])\s/).length;
    for (const l of lines) { expect(l.length).toBeLessThanOrEqual(28); expect(l.split(" ").length).toBeLessThanOrEqual(5); if (!/[,.!?]$/.test(l)) expect(l).not.toMatch(WEAK_END); }
    expect(lines.filter((l) => !l.includes(" ")).length).toBeLessThanOrEqual(sentenceEnds > 1 ? 0 : 0); }
});
test("lines: a pause or a sentence end always starts a new line", () => {
  const ws = [w("Hello", 0, 0.3), w("there.", 0.35, 0.7), w("Next", 0.8, 1.0), w("bit", 1.05, 1.2), w("after", 2.4, 2.6), w("pause", 2.65, 2.9)];
  expect(buildLines(ws).map((l) => l.ws.map((x) => x.text).join(" "))).toEqual(["Hello there.", "Next bit", "after pause"]);
});

test("lines: a pause or a sentence end starts a new line", () => {
  const lines = buildLines([w("Hi.", 0, 0.3), w("there", 0.4, 0.6), w("friend", 2.0, 2.2)]);
  expect(lines.map((l) => l.ws.map((x) => x.text).join(" "))).toEqual(["Hi.", "there", "friend"]);
  expect(lineAt(lines, 5)).toBeNull();
});

test("lines: the last line holds for a short tail, then nothing", () => {
  const lines = buildLines([w("only", 0, 0.5)]);
  expect(lineAt(lines, 0.8)).not.toBeNull();
  expect(lineAt(lines, 1.0)).toBeNull();
});

test("naming: the clip's own name stays, only the extension goes", () => {
  const now = new Date(2026, 8, 18, 1, 5);
  expect(outputName("Kitchen tour final.mp4", "mp4", now)).toBe("Kitchen tour final-captions.mp4");
  expect(outputName("IMG_1234.MOV", "mp4", now)).toBe("IMG_1234-captions.mp4");
  expect(outputBase("trim.9A6B2C3D-1111-2222-3333-444455556666.MOV", now)).toBe("trim.9A6B2C3D-1111-2222-3333-444455556666");
  expect(outputBase("PXL_20260917_101010.mp4", now)).toBe("PXL_20260917_101010");
  expect(outputBase("مقطع المطبخ.mov", now)).toBe("مقطع المطبخ");
  expect(outputBase("what: is/this?.mp4", now)).toBe("what- is-this"); // characters no file system takes
  expect(outputBase(".mp4", now)).toBe("clip-2026-09-18-0105"); // nothing usable at all
  expect(outputBase("My very long kitchen tour video for the channel final edit v2 with extra footage and more words after that.mp4", now)).toHaveLength(80);
});

test("naming: a long name is shortened in the middle, keeping the ending", () => {
  expect(displayName("Kitchen tour final-captions.mp4")).toBe("Kitchen tour final-captions.mp4");
  const long = displayName("IMG_20260918_143522_Screen-Recording-from-the-Living-Room-With-Everyone-Talking-captions.mp4", 36);
  expect(long).toHaveLength(36); expect(long.endsWith("-captions.mp4")).toBe(true); expect(long.startsWith("IMG_20260918")).toBe(true); expect(long).toContain("…");
  expect(displayName("My very long kitchen tour video for the channel final edit v2.mp4", 24)).toBe("My very long k…it v2.mp4");
  // fitName against a measure: here "fits" means at most 30 characters, on the page it is the box width in pixels
  const fits30 = (t: string) => t.length <= 30;
  const f = fitName("IMG_20260918_143522_Screen-Recording-from-the-Living-Room-captions.mp4", fits30);
  expect(f.length).toBeLessThanOrEqual(30); expect(f.endsWith("-captions.mp4")).toBe(true); expect(f.split("…").length).toBe(2);
  expect(fitName("short.mp4", fits30)).toBe("short.mp4");
});

test("audio: mono mix, trim to the limit, resample to 16 kHz", () => {
  const left = new Float32Array(48000).fill(1), right = new Float32Array(48000).fill(0);
  const out = toMono16k([left, right], 48000, 0.5);
  expect(out.length).toBe(8000); // 0.5 s at 16 kHz
  expect(out[100]).toBeCloseTo(0.5, 5);
  expect(toMono16k([new Float32Array(16000)], 16000, 10).length).toBe(16000);
});

test("estimate: measured speed wins, else cores, else webgpu", () => {
  expect(estimateFactor("wasm", 4, 24000, 12)).toBe(2);
  expect(estimateFactor("wasm", 2)).toBe(3);
  expect(estimateFactor("wasm", 8)).toBe(0.75);
  expect(estimateFactor("webgpu", 6)).toBe(0.6);
});
