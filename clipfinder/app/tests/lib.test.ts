import { test, expect } from "bun:test";
import { clock, spoken, displayName, outputName, timelineName } from "../src/lib/naming";
import { acceptWindowWords, shouldRerank, targetLengthS } from "../src/lib/stream";
import { transcriptOf, wordIndexAt, textBetween, type Word } from "../src/lib/words";
import { normalize, stem, pseudoSentences, segment, blockFor } from "../src/lib/segment";
import { pauses, snap } from "../src/lib/pause";
import { rank, features, reasons, edgeSeconds, pickSeparated } from "../src/lib/rank";
import { candidates } from "../src/lib/candidates";
import { mustPay, priceCopy, readLimitS, TRIAL_COPY } from "../src/lib/pricing";

// --- names and clocks ------------------------------------------------------------------------

test("a clock grows an hours field only when there are hours", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(65)).toBe("1:05");
  expect(clock(724)).toBe("12:04");
  expect(clock(3723)).toBe("1:02:03");
});

test("a length is said the way a person says it", () => {
  expect(spoken(48)).toBe("48 s");
  expect(spoken(260)).toBe("4 min 20 s");
  expect(spoken(300)).toBe("5 min");
});

test("a long name keeps its beginning and its ending", () => {
  const long = "a-very-long-screen-recording-name-from-a-phone-2026-09-20.mov";
  const short = displayName(long);
  expect(short.length).toBeLessThanOrEqual(35);
  expect(short.startsWith("a-very")).toBe(true);
  expect(short.endsWith(".mov")).toBe(true);
  expect(short).toContain("…");
  expect(displayName("short.mp3")).toBe("short.mp3");
});

test("a name with no spaces and no dots still shortens", () => {
  expect(displayName("x".repeat(80)).length).toBeLessThanOrEqual(35);
});

test("an output name says which moment it is and where it came from", () => {
  expect(outputName("Artemis II: The Crew.mp3", 3, 725, "mp3")).toBe("Artemis-II-The-Crew-03-at-12-05.mp3");
  expect(timelineName("Artemis II: The Crew.mp3", "edl")).toBe("Artemis-II-The-Crew-moments.edl");
});

test("a name made only of punctuation still produces a usable file name", () => {
  expect(outputName("###.mp3", 1, 0, "mp4")).toMatch(/^recording-\d{4}-\d{2}-\d{2}-01-at-0-00\.mp4$/);
});

// --- the seam between windows ----------------------------------------------------------------

test("a window contributes nothing from the sound the window before it already covered", () => {
  const local = [
    { t: 0.4, text: "already" },
    { t: 1.9, text: "heard" },
    { t: 2.1, text: "new" },
    { t: 12, text: "words" },
  ];
  const kept = acceptWindowWords(local, { startS: 28, overlapS: 2 });
  expect(kept.map((w) => w.text)).toEqual(["new", "words"]);
  expect(kept[0]!.t).toBeCloseTo(30.1, 2);
});

test("the first window has no overlap and keeps everything", () => {
  const kept = acceptWindowWords([{ t: 0, text: "one" }, { t: 1, text: "two" }], { startS: 0, overlapS: 0 });
  expect(kept).toHaveLength(2);
});

test("blank words from the recogniser never reach the transcript", () => {
  expect(acceptWindowWords([{ t: 1, text: "  " }, { t: 2, text: "ok" }], { startS: 0, overlapS: 0 })).toHaveLength(1);
});

test("the list is not rebuilt before there is enough to rank, then every few minutes", () => {
  expect(shouldRerank(120, 0)).toBe(false);
  expect(shouldRerank(240, 0)).toBe(true);
  expect(shouldRerank(300, 240)).toBe(false);
  expect(shouldRerank(430, 240)).toBe(true);
});

test("clips shrink with a short recording and never go under a minute", () => {
  expect(targetLengthS(3600, 300)).toBe(300);
  expect(targetLengthS(600, 300)).toBe(150);
  expect(targetLengthS(120, 300)).toBe(60);
});

// --- words -----------------------------------------------------------------------------------

const say = (text: string, from = 0, gap = 0.35): Word[] =>
  text.split(" ").map((w, i) => ({ t: +(from + i * gap).toFixed(2), text: w }));

test("a word index is the first word at or after a time", () => {
  const w = say("one two three four five");
  expect(wordIndexAt(w, 0)).toBe(0);
  expect(wordIndexAt(w, 0.5)).toBe(2);
  expect(wordIndexAt(w, 99)).toBe(5);
  expect(textBetween(w, 0.35, 1.05)).toBe("two three");
});

test("punctuation in the words is what makes a transcript punctuated", () => {
  expect(transcriptOf(say("hello there friend")).punctuated).toBe(false);
  expect(transcriptOf(say("hello, there friend.")).punctuated).toBe(true);
  expect(transcriptOf([]).lastWordS).toBe(0);
});

// --- segmentation ----------------------------------------------------------------------------

test("a word with no subject in it normalizes away", () => {
  expect(normalize("the")).toBe(null);
  expect(normalize("...")).toBe(null);
  expect(normalize("Scaling")).toBe("scal");
  expect(stem("scaled")).toBe("scal");
  expect(stem("cities")).toBe("city");
});

test("pseudo-sentences are fixed runs of subject-bearing words", () => {
  const ps = pseudoSentences(say(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")), 20);
  expect(ps).toHaveLength(5);
  expect(ps[0]!.tokens).toHaveLength(20);
});

test("a transcript too short to tile comes back as one section covering the whole recording", () => {
  const t = transcriptOf(say("one two three four five"));
  expect(segment(t, 600)).toEqual([{ startS: 0, endS: 600, startWord: 0, endWord: 4 }]);
});

test("an empty transcript does not throw", () => {
  expect(segment(transcriptOf([]), 600)).toHaveLength(1);
  expect(rank(transcriptOf([]), 600)).toEqual([]);
});

test("a change of subject becomes a boundary", () => {
  // Two subjects, each repeated enough that word overlap dips sharply where they meet.
  const a = "rocket engine thrust fuel nozzle chamber pressure rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight garden soil compost tomato seedling water sunlight ";
  const t = transcriptOf(say((a.repeat(40) + b.repeat(40)).trim()));
  const secs = segment(t, t.lastWordS + 1, { minSectionS: 5 });
  expect(secs.length).toBeGreaterThan(1);
  // The boundary lands near where the vocabulary actually changes.
  const turn = say(a.repeat(40).trim()).length * 0.35;
  expect(Math.min(...secs.slice(1).map((s) => Math.abs(s.startS - turn)))).toBeLessThan(turn * 0.25);
});

// --- pauses ----------------------------------------------------------------------------------

test("a gap between two words is a pause, and a boundary moves to the nearest one", () => {
  const w: Word[] = [{ t: 0, text: "a" }, { t: 0.3, text: "b" }, { t: 2.0, text: "c" }, { t: 2.3, text: "d" }];
  const ps = pauses(w);
  expect(ps).toEqual([{ at: 2.0, lengthS: 1.7 }]);
  expect(snap(2.4, ps, 1)).toEqual({ at: 2.0, snapped: true });
  expect(snap(9, ps, 1)).toEqual({ at: 9, snapped: false });
});

// --- ranking ---------------------------------------------------------------------------------

test("a passage that develops its own words scores above one that points backwards", () => {
  const dense = transcriptOf(say("orbit orbit capsule capsule docking docking orbit capsule docking crew crew"));
  const vague = transcriptOf(say("it was that they said this then those there it that this"));
  const cand = { startS: 0, endS: 60, startWord: 0, endWord: 10, sections: 1, fromSection: 0 };
  const df = new Map<string, number>();
  const a = features(cand, dense, df, 8);
  const b = features({ ...cand, endWord: 12 }, vague, df, 8);
  expect(a.selfContained).toBeGreaterThan(b.selfContained);
});

test("a problem posed early and answered later scores on order, not on presence", () => {
  const df = new Map<string, number>();
  const words = (s: string) => transcriptOf(say(s));
  const long = (head: string, tail: string) => `${head} ${"filler ".repeat(40)} ${tail}`;
  const right = words(long("the problem was getting there", "so we built a new one"));
  const wrong = words(long("so we built a new one", "the problem was getting there"));
  const span = (t: ReturnType<typeof words>) => ({ startS: 0, endS: 120, startWord: 0, endWord: t.words.length - 1, sections: 1, fromSection: 0 });
  expect(features(span(right), right, df, 8).setupPayoff).toBe(1);
  expect(features(span(wrong), wrong, df, 8).setupPayoff).toBeLessThan(1);
});

test("the reasons are sentences about the passage, never a number, and never more than two", () => {
  const span = { startS: 0, endS: 300, startWord: 0, endWord: 9, sections: 1, fromSection: 0 };
  const strong = reasons(span, { selfContained: 0.6, length: 300, setupPayoff: 1 });
  expect(strong).toEqual(["Stands on its own", "Opens with a problem and answers it later"]);
  // A passage with nothing true to say says nothing. Three cards in four used to carry "Stays on one
  // subject", which teaches a reader that the reason slot is decoration (design review, 2026-09-21).
  expect(reasons(span, { selfContained: 0, length: 300, setupPayoff: 0 })).toEqual(["Needs a line of setup first"]);
  expect(reasons({ ...span, sections: 3 }, { selfContained: 0, length: 300, setupPayoff: 0 })).toEqual(["Needs a line of setup first", "One subject across 3 turns"]);
  expect(reasons(span, { selfContained: 0, length: 300, setupPayoff: 0.5 })).toEqual(["Needs a line of setup first", "Sets something up and comes back to it"]);
  // The length is on the card beside the time; repeating it in a reason spends words the page has not got.
  for (const why of [strong, reasons(span, { selfContained: 0.6, length: 300, setupPayoff: 0 })]) {
    expect(why.length).toBeLessThanOrEqual(2);
    for (const line of why) {
      expect(line).not.toMatch(/\d+ min|\bseconds?\b/);
      expect(line).not.toMatch(/\d+(\.\d+)?\s*(score|points?|%)/i);
    }
  }
});

test("a ranked moment carries its times, its reasons and the words it opens on", () => {
  const a = "rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight ";
  const t = transcriptOf(say((a.repeat(70) + b.repeat(70)).trim(), 0, 0.5));
  const moments = rank(t, t.lastWordS + 1, { targetS: 90, n: 3, minSectionS: 20 });
  expect(moments.length).toBeGreaterThan(0);
  for (const m of moments) {
    expect(m.endS).toBeGreaterThan(m.startS);
    expect(m.why.length).toBeGreaterThan(0);
    expect(m.opening.length).toBeGreaterThan(0);
    expect(Object.keys(m).sort()).toEqual(["endS", "opening", "startS", "why"]);
  }
});

test("moments come back in the order they were ranked, not in time order", () => {
  // Two runs of the same recording must give the same list: the tie-break is the candidate's position,
  // which is what makes this deterministic rather than dependent on sort stability.
  const a = "rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight ";
  const t = transcriptOf(say((a.repeat(70) + b.repeat(70)).trim(), 0, 0.5));
  const one = rank(t, t.lastWordS + 1, { targetS: 90, minSectionS: 20 });
  const two = rank(t, t.lastWordS + 1, { targetS: 90, minSectionS: 20 });
  expect(one).toEqual(two);
});

test("every candidate starts where a section starts", () => {
  const a = "rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight ";
  const t = transcriptOf(say((a.repeat(70) + b.repeat(70)).trim(), 0, 0.5));
  const { sections, candidates: cands } = candidates(t, t.lastWordS + 1, { targetS: 90, minSectionS: 20 });
  for (const c of cands) expect(sections.some((s) => Math.abs(s.startS - c.startS) < 1e-6)).toBe(true);
});

test("a moment cannot open on the theme music or close on the sign-off", () => {
  // Measured on fourteen recordings: the margin is the same with and without this rule, and it costs one
  // creator clip in 72 (clipfinder/text/bench/edges.ts). It is here because those fourteen begin with
  // content and podcasts begin with a jingle, which the first sample built for the page opened on.
  expect(edgeSeconds(3878)).toBe(120);
  expect(edgeSeconds(600)).toBe(30); // a twentieth, so a short recording is not mostly edge
  const a = "rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight ";
  const t = transcriptOf(say((a.repeat(70) + b.repeat(70)).trim(), 0, 0.5));
  const durationS = t.lastWordS + 1;
  const edge = edgeSeconds(durationS);
  for (const m of rank(t, durationS, { targetS: 90, minSectionS: 20 })) {
    expect(m.startS).toBeGreaterThanOrEqual(edge);
    expect(m.endS).toBeLessThanOrEqual(durationS - edge);
  }
});

test("a short recording is still cut into subjects rather than left whole", () => {
  // The gate found this: 6 minutes 30, 987 words, and zero moments, because tiling needs two full
  // windows to compare and a fixed window of twelve is wider than the whole transcript.
  expect(blockFor(200)).toBe(12); // every recording in the measured corpus
  expect(blockFor(24)).toBe(4); // the six-minute fixture
  expect(blockFor(6)).toBe(4); // and the floor holds
  const a = "rocket engine thrust fuel nozzle chamber pressure ";
  const b = "garden soil compost tomato seedling water sunlight ";
  // About a thousand words over six and a half minutes, which is what the gate fed it.
  const t = transcriptOf(say((a.repeat(70) + b.repeat(70)).trim(), 0, 0.4));
  expect(t.words.length).toBeGreaterThan(900);
  expect(segment(t, t.lastWordS + 1, { minSectionS: 30 }).length).toBeGreaterThan(1);
  expect(rank(t, t.lastWordS + 1, { targetS: 98, minSectionS: 30 }).length).toBeGreaterThan(0);
});

// --- money, while there is none ----------------------------------------------------------------

test("while the tool is free nobody is asked to pay, and the paid page still exists in one piece", () => {
  // The owner, 2026-09-20: free at the start. So the page names no price, and the rail underneath is
  // asleep rather than deleted. Both states are checked here because only one of them is on the page:
  // the other would rot unread otherwise, and rotten copy is what gets written in a hurry later.
  expect(mustPay(true, false)).toBe(false); // free: a visitor saves everything
  expect(mustPay(true, true)).toBe(false); // free, and holding an old key: still nothing to pay
  expect(mustPay(false, false)).toBe(true); // priced, no key: the paywall holds
  expect(mustPay(false, true)).toBe(false); // priced, with a key: it opens

  // The trial reads four hours, as the page says it does; the free tier under a price reads half an hour.
  expect(readLimitS(true, false, 1800, 14400)).toBe(14400);
  expect(readLimitS(false, false, 1800, 14400)).toBe(1800);
  expect(readLimitS(false, true, 1800, 14400)).toBe(14400);

  // Every sentence of the paid page carries the one number, and none of them is hard-coded.
  const paid = priceCopy("$29");
  for (const [where, line] of [["tag", paid.tag], ["amount", paid.amount], ["buy", paid.buy]] as const)
    expect(line, `${where} states the price`).toContain("$29");
  expect(priceCopy("$19").buy).toBe("Buy once — $19");
  for (const line of Object.values(paid)) expect(line).not.toMatch(/\$(?!19|24|29\b)\d+/);
  // Both halves of the offer are named, because a limit found after the work is done earns one-star reviews.
  expect(paid.fine).toMatch(/30 minutes/);
  expect(paid.fine).toMatch(/four hours/);
  expect(paid.trust).toMatch(/30 minutes/);

  // And the free page names no number at all.
  for (const line of Object.values(TRIAL_COPY)) expect(line).not.toMatch(/\$\d/);
  expect(TRIAL_COPY.amount).toBe("Free");
  expect(TRIAL_COPY.fine).toMatch(/four hours/); // the limit that is actually in force
});

// --- separate moments, not one passage cut into slabs -------------------------------------------

test("two chosen moments never abut, because separate moments are the product", () => {
  // Spans every 200 s, each 300 s long, so neighbours overlap and every other one does not — the
  // shape the real shortlist has, because a candidate starts at every topic boundary.
  const ranked = Array.from({ length: 10 }, (_, i) => ({ c: { startS: i * 200, endS: i * 200 + 300 }, i }));

  // Switched off, the top four are neighbours: one passage cut into slabs, which is what a cold user
  // got back as 4:59 -> 12:29 -> 18:11 -> 23:52 on a 27:49 interview.
  expect(pickSeparated(ranked, 4, 0).map((x) => x.c.startS)).toEqual([0, 200, 400, 600]);

  // At one second, nothing abuts and nothing overlaps.
  const taken = pickSeparated(ranked, 4, 1);
  expect(taken.map((x) => x.c.startS)).toEqual([0, 400, 800, 1200]);
  for (let i = 1; i < taken.length; i++) expect(taken[i]!.c.startS - taken[i - 1]!.c.endS).toBeGreaterThanOrEqual(1);

  // The best moment stays the best moment whatever the gap — the rule declines neighbours, it never
  // re-ranks — and it comes back short rather than breaking its own promise.
  for (const g of [0, 1, 60, 600]) expect(pickSeparated(ranked, 4, g)[0]!.c.startS).toBe(0);
  expect(pickSeparated(ranked, 9, 600).length).toBeLessThan(9);
  expect(pickSeparated(ranked, 1, 1)).toHaveLength(1);

  // There is no end-to-end case here on purpose. Synthetic text does not produce real topic
  // boundaries — TextTiling needs genuine vocabulary shifts, and a fixture that yields one section
  // exercises none of this. The end-to-end claim is carried by the bench instead, over fourteen real
  // recordings: 48.3% of offered pairs abutted before this rule and 0.0% after
  // (`clipfinder/text/bench/moments.md`), which is stronger evidence than a fixture could be.
});

test("a short recording gets an answer instead of an empty list", () => {
  // One subject held for eight minutes: every section is far longer than a one-minute clip, so a
  // candidate made of whole sections cannot fit under the cap and the generator returned nothing.
  const t = transcriptOf(say(Array.from({ length: 1400 }, (_, i) => `steady${i % 9}`).join(" ")));
  const durationS = t.lastWordS + 5;

  expect(candidates(t, durationS, { targetS: 60 }).candidates).toHaveLength(0);
  const out = candidates(t, durationS, { targetS: 60, endInsideS: 20 });
  expect(out.candidates.length).toBeGreaterThan(0);

  // What it hands back is still a real clip: it opens on a topic boundary and is at least half the
  // length asked for, the two things the generator promised before this option existed.
  const starts = new Set(out.sections.map((s) => s.startS));
  for (const c of out.candidates) {
    expect(starts.has(c.startS), `a candidate starts at ${c.startS}, which is not a boundary`).toBe(true);
    expect(c.endS - c.startS).toBeGreaterThanOrEqual(30);
    expect(c.endWord).toBeGreaterThan(c.startWord);
  }

  // It only ever rescues what would otherwise be discarded. Every candidate the plain generator finds
  // survives unchanged, on a recording where whole sections do fit.
  const long = transcriptOf(say(Array.from({ length: 3000 }, (_, i) => `steady${i % 9}`).join(" ")));
  const longDur = long.lastWordS + 5;
  const plain = candidates(long, longDur, { targetS: 700 }).candidates;
  const rescued = candidates(long, longDur, { targetS: 700, endInsideS: 20 }).candidates;
  expect(plain.length).toBeGreaterThan(0);
  for (const c of plain) expect(rescued).toContainEqual(c);
});
