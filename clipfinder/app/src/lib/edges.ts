// Where a chosen moment starts and ends, once it has been chosen.
//
// The ranker finds a passage from topic boundaries, and a topic boundary is only known to about seven
// seconds, so the moments it hands back open wherever that estimate fell: in the tail of the previous
// answer, three words into a sentence. On the page's own sample, 2026-09-22 (a 15-minute interview), all
// seven moments opened mid-sentence, and every card said so: "Leans on what came before". The bench
// counted the same thing on the creators' recordings: 5.6% of offered moments open on a sentence.
//
// Moving the START to a sentence was measured before (`clipfinder/text/bench/moments.md`, R3) and cost
// 2.6 points, because it moved candidates BEFORE the ranking and so changed what was picked. This moves
// them AFTER: the same moments are chosen, then each one's edges slide to the nearest whole sentence. A
// question is preferred as an opening — in an interview the question IS the setup, and a clip that opens
// on it needs nothing before it. The bench measures this as R5, on the same recordings and bars.
//
// It never lets a moment cross into its neighbour, and never takes a moment outside the lengths the
// generator itself allows. A transcript without punctuation is left exactly as it was.

import type { Transcript } from "./words";

/** A full stop, a question mark or an exclamation mark, through any closing quote or bracket. */
const TERMINAL = /[.!?]["'’”)\]]*$/;
const ELLIPSIS = /\.\.\.["'’”)\]]*$/;
const INITIAL = /^\p{L}\.$/u;
const ABBREV = /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|ltd|co|no|fig|approx|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m)\.$/i;

/** Does this word finish a sentence? The same guards the bench counts (`thought.ts`): "J." and "Dr." do not. */
export function endsThought(text: string): boolean {
  const t = text.replace(/^["'“‘(\[]+/, "");
  return TERMINAL.test(t) && !ELLIPSIS.test(t) && !INITIAL.test(t) && !ABBREV.test(t);
}

/** Does word `k` begin a sentence? */
// The recording's first word counts only when it reads as one: a recogniser's first window is often the
// room settling (on the page's sample, "with the tobacco toys but other that grade yeah").
export const beginsSentence = (t: Transcript, k: number) =>
  k === 0 ? /^["'“‘(]*\p{Lu}/u.test(t.words[0]?.text ?? "") : endsThought(t.words[k - 1]?.text ?? "");

/** Is the sentence that begins at word `k` a question? Looks at most `maxWords` ahead for where it ends. */
export function isQuestionAt(t: Transcript, k: number, maxWords = 60): boolean {
  for (let j = k; j < t.words.length && j < k + maxWords; j++) if (endsThought(t.words[j]!.text)) return /\?["'’”)\]]*$/.test(t.words[j]!.text);
  return false;
}

export type Span = { startS: number; endS: number; startWord: number; endWord: number };

export type EdgeLimits = {
  /** The moment may not start before this (the end of the moment before it, plus the gap). */
  earliestS: number;
  /** Nor end after this (the start of the moment after it, minus the gap). */
  latestS: number;
  /** The lengths the generator allows: half the target up to 1.8 times it. */
  minLenS: number;
  maxLenS: number;
  durationS: number;
};

/** How far an edge may move, each way. A topic boundary is resolved to about seven seconds; this is twice that and a little. */
export const BACK_S = 15;
export const FORWARD_S = 20;
/** A question is worth this many seconds of distance: preferred, but not dragged in from anywhere. */
const QUESTION_BONUS_S = 12;
/** Speech starts a moment before the word's estimated time; the recogniser places words across the window. */
const LEAD_S = 0.25;

/**
 * Slide a chosen moment's start to the nearest sentence start (a question preferred), and its end to the
 * nearest sentence end. Returns the moment unchanged where no whole sentence is in reach.
 */
export function cleanEdges(m: Span, t: Transcript, lim: EdgeLimits): Span {
  if (!t.punctuated || !t.words.length) return m;
  const w = t.words;
  let out = { ...m };

  // The start.
  if (!beginsSentence(t, m.startWord)) {
    let best: { k: number; cost: number } | null = null;
    // Scan outward from the current start; the window is in seconds, the words are in time order.
    let k = m.startWord;
    while (k > 0 && w[k - 1]!.t >= m.startS - BACK_S) k--;
    for (; k < w.length && w[k]!.t <= m.startS + FORWARD_S && k < m.endWord; k++) {
      if (!beginsSentence(t, k)) continue;
      const at = Math.max(0, w[k]!.t - LEAD_S);
      if (at < lim.earliestS || m.endS - at < lim.minLenS || m.endS - at > lim.maxLenS) continue;
      const cost = Math.abs(at - m.startS) - (isQuestionAt(t, k) ? QUESTION_BONUS_S : 0);
      if (!best || cost < best.cost) best = { k, cost };
    }
    if (best) out = { ...out, startWord: best.k, startS: Math.max(0, w[best.k]!.t - LEAD_S) };
  }

  // The end: after the last word of a finished sentence, before the next one starts.
  if (!(m.endWord >= w.length - 1 || endsThought(w[m.endWord]!.text))) {
    let best: { k: number; cost: number } | null = null;
    let k = m.endWord;
    while (k > out.startWord && w[k - 1]!.t >= m.endS - BACK_S) k--;
    for (; k < w.length && w[k]!.t <= m.endS + FORWARD_S; k++) {
      if (!endsThought(w[k]!.text)) continue;
      const at = k + 1 < w.length ? Math.min(w[k + 1]!.t - LEAD_S, lim.durationS) : lim.durationS;
      if (at > lim.latestS || at - out.startS < lim.minLenS || at - out.startS > lim.maxLenS) continue;
      const cost = Math.abs(at - m.endS);
      if (!best || cost < best.cost) best = { k, cost };
    }
    if (best) {
      const k2 = best.k;
      out = { ...out, endWord: k2, endS: k2 + 1 < w.length ? Math.min(w[k2 + 1]!.t - LEAD_S, lim.durationS) : lim.durationS };
    }
  }
  return out;
}

/**
 * Clean the edges of a whole list, each moment bounded by its neighbours in time so the gap rule that
 * chose them still holds afterwards. The list keeps its order (strongest first).
 */
export function cleanAll<T extends Span>(picked: T[], t: Transcript, durationS: number, targetS: number, gapS: number, overshoot = 1.8): T[] {
  const byTime = [...picked].sort((a, b) => a.startS - b.startS);
  const done = new Map<T, Span>();
  for (let i = 0; i < byTime.length; i++) {
    const m = byTime[i]!;
    const prev = i > 0 ? done.get(byTime[i - 1]!)! : null;
    const next = byTime[i + 1];
    done.set(
      m,
      cleanEdges(m, t, {
        earliestS: prev ? prev.endS + gapS : 0,
        latestS: next ? next.startS - gapS : durationS,
        minLenS: Math.min(targetS * 0.5, m.endS - m.startS),
        maxLenS: Math.max(targetS * overshoot, m.endS - m.startS),
        durationS,
      }),
    );
  }
  return picked.map((m) => ({ ...m, ...done.get(m)! }));
}
