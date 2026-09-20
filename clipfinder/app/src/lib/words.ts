// The recording as words on a clock. Everything downstream of the recogniser reads text, never sound.
//
// This is the browser half of `clipfinder/text/transcript.ts`: the same shape, without the caption-file
// reader, which only the research tree needs. The research tree is where a change to the ranking is
// measured; this is where it ships.

export type Word = {
  /** Seconds from the start of the recording. */
  t: number;
  text: string;
};

export type Transcript = {
  words: Word[];
  /** Whether the words carry sentence punctuation, which decides how sentences are found. */
  punctuated: boolean;
  /** Last word's timestamp. The recording may run longer than its last word. */
  lastWordS: number;
};

export function transcriptOf(words: Word[]): Transcript {
  const sample = words.slice(0, 4000);
  return {
    words,
    punctuated: sample.length > 0 && sample.filter((w) => /[.?!,]$/.test(w.text)).length / sample.length > 0.05,
    lastWordS: words.length ? words[words.length - 1]!.t : 0,
  };
}

/** Index of the first word at or after `startS`. Binary search; the word lists run to 40k entries. */
export function wordIndexAt(words: Word[], startS: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.t < startS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Plain text of a time range, for the line of the recording a moment is shown with. */
export function textBetween(words: Word[], startS: number, endS: number): string {
  const out: string[] = [];
  for (let i = wordIndexAt(words, startS); i < words.length; i++) {
    const w = words[i]!;
    if (w.t >= endS) break;
    out.push(w.text);
  }
  return out.join(" ");
}
