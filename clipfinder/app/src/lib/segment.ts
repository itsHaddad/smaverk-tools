// Cut the transcript where the subject changes.
//
// TextTiling (Hearst, 1997) and nothing cleverer, for a reason that is the product rather than a coding
// style: it needs no model, no weights, no network and no licence, so the whole of this step runs on the
// device with nothing to download. Sentence embeddings were measured against it on all fourteen
// recordings that matter and lost — potion-base-8M scored +4.4 against word overlap's +7.4 — so the
// 90 MB download they would cost buys nothing.
//
// Ported from `clipfinder/text/segment.ts`, which is where a change to it is measured first. The
// embedding branch is not carried over, because it is not shipped.

import type { Transcript, Word } from "./words";

/** Tokens per pseudo-sentence. Hearst's 20; at ~180 words a minute that is about seven seconds. */
export const TOKENS_PER_PSEUDO = 20;

/**
 * Pseudo-sentences either side of a gap. Hearst used 6 for written essays of a few thousand words. A
 * two-hour recording is ten times that and its subjects last minutes, not paragraphs, so the window has
 * to grow with the material or every hesitation reads as a new topic.
 */
export const BLOCK_PSEUDOS = 12;

/**
 * The window a particular transcript can actually afford.
 *
 * Tiling needs at least two full windows to compare, so a fixed twelve silently gives up on anything
 * under about twenty-four pseudo-sentences and hands back one section covering the whole recording —
 * which then fails the length test and produces nothing at all. That is what a six-and-a-half-minute
 * recording did in the gate: 987 words, 51 silences, zero moments.
 *
 * A sixth of the transcript, never more than twelve and never fewer than four. Every recording in the
 * measured corpus is 45 minutes or longer and has 150 pseudo-sentences or more, so all of them stay at
 * twelve and every number in `clipfinder/text/` still stands.
 */
export const blockFor = (pseudos: number) => Math.max(4, Math.min(BLOCK_PSEUDOS, Math.round(pseudos / 6)));

// Closed-class words carry no subject. Trimmed to what actually shows up at the top of spoken-English
// frequency lists; a longer list changes nothing measurable and invites argument.
const STOP = new Set(
  ("a about all also am an and any are as at be because been but by can could did do does doing done down each even " +
    "for from further get go going got had has have having he her here hers him his how i if in into is it its just " +
    "know like made make many me might more most much must my no nor not now of off on once one only or other our out " +
    "over own really right said same say says see she should so some such than that the their theirs them then there " +
    "these they thing things think this those through to too up us very was way we well were what when where which " +
    "while who whom why will with would yeah yes you your yours actually basically kind lot mean okay sort thank " +
    "thanks gonna wanna oh uh um hmm")
    .split(" "),
);

/**
 * Crude suffix stripping: "scaling", "scaled" and "scales" must count as the same word or a subject
 * that persists across a minute looks like three different ones. A real Porter stemmer is a page of
 * rules for a gain this measurement cannot see.
 */
export function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ["ingly", "edly", "ing", "ies", "ied", "es", "ed", "ly", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const base = w.slice(0, -suf.length);
      return suf === "ies" || suf === "ied" ? `${base}y` : base;
    }
  }
  return w;
}

/** A word reduced to its subject-bearing form, or null if it carries no subject at all. */
export function normalize(text: string): string | null {
  const w = text.toLowerCase().replace(/[^a-z']/g, "");
  if (w.length < 2 || STOP.has(w)) return null;
  return stem(w);
}

export type Pseudo = { tokens: string[]; startWord: number; endWord: number };

export function pseudoSentences(words: Word[], size = TOKENS_PER_PSEUDO): Pseudo[] {
  const out: Pseudo[] = [];
  let cur: Pseudo = { tokens: [], startWord: 0, endWord: 0 };
  for (const [i, w] of words.entries()) {
    const n = normalize(w.text);
    if (!n) continue;
    if (!cur.tokens.length) cur.startWord = i;
    cur.tokens.push(n);
    cur.endWord = i;
    if (cur.tokens.length >= size) {
      out.push(cur);
      cur = { tokens: [], startWord: 0, endWord: 0 };
    }
  }
  if (cur.tokens.length >= size / 2) out.push(cur);
  return out;
}

function counts(pseudos: Pseudo[], from: number, to: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = from; i < to; i++) for (const t of pseudos[i]!.tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) {
    nb += v * v;
    const av = a.get(k);
    if (av) dot += av * v;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** How alike the k pseudo-sentences before each gap are to the k after it. One score per gap. */
export function gapScores(pseudos: Pseudo[], k = BLOCK_PSEUDOS): number[] {
  const out: number[] = [];
  for (let g = 1; g < pseudos.length; g++) {
    out.push(cosine(counts(pseudos, Math.max(0, g - k), g), counts(pseudos, g, Math.min(pseudos.length, g + k))));
  }
  return out;
}

export function smooth(xs: number[], radius = 1): number[] {
  if (radius < 1) return xs.slice();
  return xs.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(xs.length - 1, i + radius); j++) {
      sum += xs[j]!;
      n++;
    }
    return sum / n;
  });
}

/**
 * Hearst's depth score: how far a dip falls below the nearest peak on each side. A shallow wobble in a
 * generally low stretch is not a boundary; a deep notch between two high plateaus is.
 */
export function depthScores(gaps: number[]): number[] {
  return gaps.map((v, i) => {
    let l = v;
    for (let j = i - 1; j >= 0 && gaps[j]! >= l; j--) l = gaps[j]!;
    let r = v;
    for (let j = i + 1; j < gaps.length && gaps[j]! >= r; j++) r = gaps[j]!;
    return l - v + (r - v);
  });
}

export type Section = { startS: number; endS: number; startWord: number; endWord: number };

export type SegmentOptions = {
  tokensPerPseudo?: number;
  blockPseudos?: number;
  smoothRadius?: number;
  /** Hearst's cutoff is mean − sd/2. Higher means fewer, longer sections. */
  cutoffSd?: number;
  /** No two boundaries closer than this, so one wobble does not become three sections. */
  minSectionS?: number;
};

/** Cut a transcript into topical sections. Boundaries land on a word, not on an arbitrary clock time. */
export function segment(t: Transcript, durationS: number, opts: SegmentOptions = {}): Section[] {
  return segmentDetailed(t, durationS, opts).sections;
}

/** The same cut, plus how deep the dip was at each section's opening boundary. */
export function segmentDetailed(t: Transcript, durationS: number, opts: SegmentOptions = {}): { sections: Section[]; boundaryDepth: number[] } {
  const { tokensPerPseudo = TOKENS_PER_PSEUDO, smoothRadius = 1, cutoffSd = 0.5, minSectionS = 45 } = opts;
  const whole = (): { sections: Section[]; boundaryDepth: number[] } => ({
    sections: [{ startS: 0, endS: durationS, startWord: 0, endWord: Math.max(0, t.words.length - 1) }],
    boundaryDepth: [0],
  });
  if (!t.words.length) return whole();
  const pseudos = pseudoSentences(t.words, tokensPerPseudo);
  const blockPseudos = opts.blockPseudos ?? blockFor(pseudos.length);
  if (pseudos.length < 2 * blockPseudos) return whole();
  const depths = depthScores(smooth(gapScores(pseudos, blockPseudos), smoothRadius));
  const mean = depths.reduce((n, v) => n + v, 0) / depths.length;
  const sd = Math.sqrt(depths.reduce((n, v) => n + (v - mean) ** 2, 0) / depths.length);
  const cutoff = mean + cutoffSd * sd;

  // A boundary is a local maximum of depth above the cutoff: the deepest point of its own dip, not
  // every point on the way down.
  const boundaryWords: number[] = [];
  const boundaryDepths: number[] = [];
  for (let i = 0; i < depths.length; i++) {
    if (depths[i]! < cutoff) continue;
    if (i > 0 && depths[i - 1]! > depths[i]!) continue;
    if (i < depths.length - 1 && depths[i + 1]! > depths[i]!) continue;
    boundaryWords.push(pseudos[i + 1]!.startWord);
    boundaryDepths.push(depths[i]!);
  }

  const cuts = [0, ...boundaryWords, t.words.length - 1];
  // The recording's own opening is a boundary, but not one TextTiling measured; it gets the median
  // depth rather than zero, so a first section is neither flattered nor punished by this feature.
  const median = boundaryDepths.length ? [...boundaryDepths].sort((a, b) => a - b)[boundaryDepths.length >> 1]! : 0;
  const cutDepths = [median, ...boundaryDepths, 0];
  const sections: Section[] = [];
  const boundaryDepth: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const startWord = cuts[i]!;
    const endWord = cuts[i + 1]!;
    const startS = t.words[startWord]!.t;
    const endS = i + 2 === cuts.length ? durationS : t.words[endWord]!.t;
    const last = sections[sections.length - 1];
    if (last && (endS - last.startS < minSectionS + (startS - last.startS) || startS - last.startS < minSectionS)) {
      // Too close to the previous boundary to be a separate subject: absorb it.
      last.endS = endS;
      last.endWord = endWord;
      continue;
    }
    sections.push({ startS, endS, startWord, endWord });
    boundaryDepth.push(cutDepths[i]!);
  }
  return sections.length ? { sections, boundaryDepth } : whole();
}
