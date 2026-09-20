// Results while it is still reading.
//
// Ranking the whole of what has been heard so far costs 0.0002 times real time — two tenths of a second
// on a recording that takes an hour to read. So there is no reason to make anyone wait for the end: the
// list is rebuilt every few minutes of transcribed sound and moments appear, move and settle as the
// recording goes on.
//
// The two jobs here are the seams. Windows overlap so the recogniser never loses a word on a boundary,
// which means the overlap is transcribed twice and must be emitted once.

import type { Word } from "./words";

/** How much transcribed sound to gather before the list is rebuilt. */
export const RERANK_EVERY_S = 180;

/** A window shorter than this cannot hold a candidate, so ranking it is wasted work. */
export const MIN_RANKABLE_S = 240;

export type WindowSpan = { startS: number; overlapS: number };

/**
 * Words this window is allowed to contribute, with their times moved onto the recording's clock.
 *
 * A window accepts nothing from its overlapping head: the window before it already covered that sound
 * and already emitted those words. The overlap exists to give the model context, not content.
 */
export function acceptWindowWords(local: { t: number; text: string }[], w: WindowSpan): Word[] {
  const out: Word[] = [];
  for (const x of local) {
    if (x.t < w.overlapS) continue;
    const text = x.text.trim();
    if (text) out.push({ t: +(w.startS + x.t).toFixed(2), text });
  }
  return out;
}

/**
 * Whether enough new sound has been read to be worth rebuilding the list.
 *
 * The first rebuild waits for a rankable stretch, because a shortlist built from ninety seconds offers
 * one candidate and then replaces it a minute later, which reads as the tool changing its mind.
 */
export function shouldRerank(transcribedS: number, lastRankedS: number, everyS = RERANK_EVERY_S, minS = MIN_RANKABLE_S): boolean {
  if (transcribedS < minS) return false;
  return transcribedS - lastRankedS >= everyS;
}

/**
 * How long the clips should be, given how long the recording is.
 *
 * Asked for a five-minute clip, a twelve-minute recording has room for two and they overlap; the
 * shortlist collapses and nothing is found. So the target shrinks with the recording until it reaches
 * a minute, below which there is nothing here to do.
 */
export function targetLengthS(durationS: number, wantedS: number): number {
  return Math.max(60, Math.min(wantedS, durationS / 4));
}
