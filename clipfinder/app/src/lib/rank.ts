// The finder.
//
// Three numbers decide the order, and it is three on purpose. Fourteen candidates for this job were
// measured one at a time against 169 clips that the people who made those recordings had cut
// themselves, and most of them scored BELOW throwing darts — including the three the brief was most
// confident about (a question that gets answered, named people and places, signpost phrases) and the
// one carried over from the first version of this tool (laughter and applause). They are not
// down-weighted here, they are absent; a number that points the wrong way cannot be rescued by a
// smaller coefficient.
//
// What survived, and what each is worth on its own over darts, leaving each show out of the fitting in
// turn: +7.0 / +5.9 / +10.4 on clean text, and about half of that at the error rate of the recogniser
// that runs in the page. Everything here is measured in `clipfinder/text/`, which is the only place a
// change to it may be argued.
//
//   selfContained  the passage develops what it introduces and does not open by pointing backwards
//   length         long enough to be the kind of thing people publish
//   setupPayoff    a problem posed in the opening third and resolved later — order, not mere presence
//
// `setupPayoff` is the strongest single one at +8.6 and correlates only 0.155 with length, which is why
// three beats two. `hook` looked like a fourth at +3.2 pooled and fell to −0.8 / −0.8 / +0.0 once the
// shows were pulled apart, so it is not here.

import { candidates, type Candidate, type CandidateOptions } from "./candidates";
import { normalize } from "./segment";
import { textBetween, type Transcript } from "./words";

/** Words that point outside themselves. A passage opening on these needs what came before it. */
const DEICTIC = new Set("it its that this these those they them he she him her his hers there then such".split(" "));

/** A problem posed, then resolved. Measured as order, not as presence. */
const SETUP = /\b(the (problem|question|issue|challenge)|we (didn'?t|couldn'?t)|i (didn'?t|couldn'?t)|how do you|what happens (if|when)|the hard part)\b/i;
const PAYOFF = /\b(so (we|i|what we)|turns out|the answer|what (we|i) did|and that'?s (why|how)|the way (we|i) solved|in the end|eventually)\b/i;

export type Features = { selfContained: number; length: number; setupPayoff: number };

/** Equal weight after z-scoring within the recording: no coefficient is better supported than 1. */
export const WEIGHTS: Features = { selfContained: 1, length: 1, setupPayoff: 1 };

export type Moment = {
  startS: number;
  endS: number;
  /** Plain sentences a person can read and disagree with. Never a score. */
  why: string[];
  /** The first words spoken, so the moment is recognisable without playing it. */
  opening: string;
};

function z(xs: number[]): number[] {
  const mean = xs.reduce((n, v) => n + v, 0) / Math.max(xs.length, 1);
  const sd = Math.sqrt(xs.reduce((n, v) => n + (v - mean) ** 2, 0) / Math.max(xs.length, 1)) || 1;
  return xs.map((v) => (v - mean) / sd);
}

/**
 * The three numbers for one candidate.
 *
 * `selfContained` is two halves pulling the same way: an opening that does not point backwards, and a
 * body that develops the terms it introduces rather than mentioning them once in passing. Rarity is
 * measured against the whole recording, so "the" counts for nothing and a word used only here counts
 * for a lot.
 */
export function features(cand: Candidate, t: Transcript, df: Map<string, number>, sections: number): Features {
  const idf = (term: string) => Math.log((sections + 1) / ((df.get(term) ?? 0) + 1));
  const counted = new Map<string, number>();
  for (let i = cand.startWord; i <= cand.endWord && i < t.words.length; i++) {
    const n = normalize(t.words[i]!.text);
    if (n) counted.set(n, (counted.get(n) ?? 0) + 1);
  }
  let specific = 0;
  let developed = 0;
  for (const [term, n] of counted) {
    if (idf(term) < 0.5) continue;
    specific++;
    if (n >= 2) developed++;
  }
  const opening = t.words.slice(cand.startWord, Math.min(cand.startWord + 40, t.words.length));
  const deictic = opening.filter((w) => DEICTIC.has(w.text.toLowerCase().replace(/[^a-z']/g, ""))).length / Math.max(opening.length, 1);

  const third = Math.floor((cand.endWord - cand.startWord) / 3);
  const cut = cand.startWord + Math.max(20, third);
  const lower = (from: number, to: number) =>
    t.words
      .slice(from, Math.min(to + 1, t.words.length))
      .map((w) => w.text.toLowerCase())
      .join(" ");

  return {
    selfContained: (specific ? developed / specific : 0) - deictic,
    length: cand.endS - cand.startS,
    setupPayoff: (SETUP.test(lower(cand.startWord, cut)) ? 0.5 : 0) + (PAYOFF.test(lower(cut, cand.endWord)) ? 0.5 : 0),
  };
}

/**
 * How much of each end of a recording is its opening and its closing rather than its content: two
 * minutes, or a twentieth for anything short enough that two minutes would be most of it.
 */
export const edgeSeconds = (durationS: number) => Math.min(120, durationS * 0.05);

export type RankOptions = Partial<CandidateOptions> & {
  /** How long the clips should run. */
  targetS?: number;
  /** How many to return. */
  n?: number;
  /**
   * Seconds of clear air a chosen moment must keep from every moment already chosen.
   *
   * Without this the list is plain top N, and because a candidate starts at every topic boundary the
   * highest-scoring ones are usually neighbours: the tool cuts the middle of a recording into
   * contiguous slabs and hands them back as separate finds. A cold user got 4:59→12:29→18:11→23:52
   * on a 27:49 interview — three "moments" with no gaps between them — and said the obvious thing,
   * that a seven-minute slab means she still has to sit through it.
   *
   * Measured against the creators themselves (`clipfinder/text/bench/moments.md`): THEIR consecutive
   * published clips abut in 6.4% of pairs, ours abutted in 48.3%, and with this at one second ours
   * abut in **0.0%**. It is not a cost dressed up as a quality fix — it is the largest improvement
   * ever measured on this ranker: **+14.2 points against darts where plain top N scores +8.0**, with
   * luck falling from 7.2% to 0.3%, positive in all three shows (+14.3/+15.3/+12.4 against
   * +9.7/+11.0/−0.3) and in all three leave-one-show-out folds, at zero cost — no creator clip goes
   * out of reach and every list still fills.
   *
   * One second, not more, although a 60 s gap scored higher (+15.7). The bar was pre-registered as
   * the SMALLEST gap that brings abutting down to the creators' own rate, because picking the
   * best-scoring value off a sweep of five is how a corpus gets fitted, and 1.5 points is one hit in
   * seventy-two. A larger gap also starts refusing to fill the list: at 120 s it declines 3 of 72.
   */
  gapS?: number;
};

/** The default clear air between two moments: enough to forbid abutting, and nothing more. */
export const GAP_S = 1;

/**
 * Walk a ranked list best-first and take an item only if it keeps `gapS` seconds of clear air from
 * everything already taken, so the answer is separate finds rather than one passage cut into slabs.
 *
 * It can come back short of `want`, and that is the honest outcome rather than a bug: there were not
 * that many separate things to offer. `gapS` of zero switches the rule off entirely.
 */
export function pickSeparated<T extends { c: { startS: number; endS: number } }>(ranked: T[], want: number, gapS: number): T[] {
  const taken: T[] = [];
  for (const x of ranked) {
    if (taken.length >= want) break;
    if (gapS > 0 && taken.some(({ c: o }) => x.c.startS - o.endS < gapS && o.startS - x.c.endS < gapS)) continue;
    taken.push(x);
  }
  return taken;
}

export function rank(t: Transcript, durationS: number, opts: RankOptions = {}): Moment[] {
  const targetS = opts.targetS ?? 300;
  const gapS = opts.gapS ?? GAP_S;
  const { sections, candidates: cands } = candidates(t, durationS, {
    snapToPauseS: 3,
    edgeS: edgeSeconds(durationS),
    endInsideS: 20,
    ...opts,
    targetS,
  });
  if (!cands.length) return [];

  // How many sections each term appears in, so a term used throughout counts for less than one used here.
  const df = new Map<string, number>();
  for (const s of sections) {
    const seen = new Set<string>();
    for (let i = s.startWord; i <= s.endWord && i < t.words.length; i++) {
      const n = normalize(t.words[i]!.text);
      if (n) seen.add(n);
    }
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const feats = cands.map((c) => features(c, t, df, sections.length));
  const columns = (Object.keys(WEIGHTS) as (keyof Features)[]).map((f) => z(feats.map((x) => x[f])).map((v) => v * WEIGHTS[f]));
  const scores = feats.map((_, i) => columns.reduce((n, col) => n + col[i]!, 0));
  const ranked = cands.map((c, i) => ({ c, s: scores[i]!, f: feats[i]!, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  return pickSeparated(ranked, opts.n ?? cands.length, gapS)
    .map(({ c, f }) => ({
      startS: +c.startS.toFixed(1),
      endS: +c.endS.toFixed(1),
      why: reasons(c, f),
      opening: openingLine(t, c),
    }));
}

/** The first few words, so the list reads like the recording rather than like a table of numbers. */
export function openingLine(t: Transcript, c: Candidate, words = 9): string {
  const text = t.words
    .slice(c.startWord, Math.min(c.startWord + words, t.words.length))
    .map((w) => w.text)
    .join(" ")
    .trim();
  return text ? tidyOpening(text) : textBetween(t.words, c.startS, c.startS + 12);
}

/**
 * The quote on a card, tidied for reading only — the boundary does not move and no score changes.
 *
 * A moment can open mid-sentence: moving the start to a sentence was measured at −2.6 points and did not
 * ship (bench/moments.md). So the card opens with an ellipsis, which reads as a deliberate excerpt rather
 * than a broken sentence, and a word the recogniser heard twice in a row is printed once. The design
 * review, 2026-09-21: "put some some thought" was the first line in the shop window and read as a bug in
 * the page. What is cut, saved and exported is untouched by this.
 */
export const display = (text: string) => text.replace(/\b(\w+) \1\b/gi, "$1");

/** The same tidy, applied to a quote that was written down earlier: the sample on the page is stored text. */
export const tidyOpening = (text: string) => {
  const t = display(text).replace(/^…\s*/, "").replace(/\s*…$/, "").trim();
  return t ? `…${t}…` : t;
};

/**
 * Why this one is in the list, in words the person can check against the recording and disagree with.
 *
 * Never a score and never a prediction. Each line names something that is true of the passage, so
 * someone who plays it can tell within ten seconds whether the tool read it right.
 *
 * At most two lines, strongest first, and never the length — the length is already on the card next to
 * the time, and a page at rest has 240 words for everything (UiStandard.md).
 */
export function reasons(c: Candidate, f: Features): string[] {
  const out: string[] = [];
  // The first line says what the strongest feature measured, whichever way it came out. It used to be said
  // only when the answer flattered the passage, and everything else fell through to "Stays on one subject"
  // — three cards in four carrying one sentence, which teaches a reader that the slot is decoration
  // (design review, 2026-09-21). Saying the unflattering half is both more honest and more useful: it
  // tells the person this one needs a line of setup before they post it.
  out.push(f.selfContained > 0.35 ? "Explains itself, with no need for what came before" : "Leans on what came before, so give it a line of setup");
  if (f.setupPayoff >= 1) out.push("Opens with a problem and answers it later");
  else if (f.setupPayoff > 0) out.push("Sets something up and comes back to it");
  else if (c.sections > 1) out.push(`One subject across ${c.sections} turns`);
  return out.slice(0, 2);
}
