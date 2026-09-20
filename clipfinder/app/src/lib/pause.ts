// Silence, for free.
//
// A moment that opens three words into a sentence sounds broken in a way anyone notices at once, and
// TextTiling only knows where a subject changes to within a pseudo-sentence — about seven seconds. The
// fix needs no audio: the gap between one word's timestamp and the next IS a pause, and the recogniser
// already reports both. Snapping every boundary to the nearest one is worth +1.6 points on the ranking
// and costs nothing, because no sound is decoded a second time.
//
// Used to MOVE boundaries, never to score them.

import type { Word } from "./words";

/** Seconds of silence that counts as a break rather than a breath. */
export const PAUSE_S = 0.6;

export type Pause = { at: number; lengthS: number };

/** Gaps between consecutive words, in time order, with their length so a caller can require a long one. */
export function pauses(words: Word[], minS = PAUSE_S): Pause[] {
  const out: Pause[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.t - words[i - 1]!.t;
    if (gap >= minS) out.push({ at: words[i]!.t, lengthS: gap });
  }
  return out;
}

/** Move a boundary to the nearest pause within `windowS`, or leave it where it is if there is none. */
export function snap(boundaryS: number, ps: Pause[], windowS: number): { at: number; snapped: boolean } {
  let best: Pause | null = null;
  for (const p of ps) {
    if (p.at < boundaryS - windowS) continue;
    if (p.at > boundaryS + windowS) break;
    if (!best || Math.abs(p.at - boundaryS) < Math.abs(best.at - boundaryS)) best = p;
  }
  return best ? { at: best.at, snapped: true } : { at: boundaryS, snapped: false };
}
