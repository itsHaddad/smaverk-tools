import { expect, test } from "bun:test";
import { beginsSentence, cleanAll, cleanEdges, endsThought, isQuestionAt } from "../src/lib/edges";
import { transcriptOf, type Word } from "../src/lib/words";

// One word a second, so a word's index is its time.
const words = (text: string): Word[] => text.split(" ").map((w, i) => ({ t: i, text: w }));
const lim = { earliestS: 0, latestS: 1e9, minLenS: 1, maxLenS: 1e9, durationS: 1e9 };

test("sentence ends: the guards the bench counts", () => {
  expect(endsThought("done.")).toBe(true);
  expect(endsThought("why?")).toBe(true);
  expect(endsThought('"stop!"')).toBe(true);
  expect(endsThought("so...")).toBe(false);
  expect(endsThought("J.")).toBe(false);
  expect(endsThought("Dr.")).toBe(false);
  expect(endsThought("and")).toBe(false);
});

test("a moment opening mid-sentence moves to the question nearby, not only the nearest start", () => {
  // 0-4 the tail of an answer, 5 a short sentence, 7-12 the interviewer's question, then the answer.
  const t = transcriptOf(words("ready to go and done. It's awesome. So when did you get there? We came up in March and stayed there."));
  const m = { startS: 2, endS: 20, startWord: 2, endWord: 20 };
  const out = cleanEdges(m, t, lim);
  expect(beginsSentence(t, out.startWord)).toBe(true);
  expect(isQuestionAt(t, out.startWord)).toBe(true);
  expect(t.words[out.startWord]!.text).toBe("So");
});

test("the end moves to a finished sentence", () => {
  const t = transcriptOf(words("It starts here and goes on. Then it keeps going until here. And more"));
  const out = cleanEdges({ startS: 0, endS: 8, startWord: 0, endWord: 8 }, t, lim);
  expect(endsThought(t.words[out.endWord]!.text)).toBe(true);
});

test("an unpunctuated transcript is left exactly as it was", () => {
  const t = transcriptOf(words("no punctuation here at all just words going on and on for a while longer still"));
  const m = { startS: 3, endS: 12, startWord: 3, endWord: 12 };
  expect(cleanEdges(m, t, lim)).toEqual(m);
});

test("a moment never moves into its neighbour, so the gap rule still holds", () => {
  const t = transcriptOf(words("One. Two three four five six. Seven eight nine ten. Eleven twelve thirteen. Fourteen fifteen sixteen seventeen."));
  const picked = [
    { startS: 2, endS: 8, startWord: 2, endWord: 8 },
    { startS: 9, endS: 16, startWord: 9, endWord: 16 },
  ];
  const out = cleanAll(picked, t, 17, 6, 1);
  const [a, b] = [...out].sort((x, y) => x.startS - y.startS);
  expect(b!.startS - a!.endS).toBeGreaterThanOrEqual(1);
});
