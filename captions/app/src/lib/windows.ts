// windows.ts: how a long clip is split so captions can appear while the rest is still being listened to.
// Whisper hears 30 s at a time and pads shorter audio to 30 s, so every window costs about the same. The clip is
// covered with the fewest 30 s windows, spread evenly, so a 60 s clip is two passes and a 5-minute clip ten.
// Where windows overlap, the words each one keeps are cut at the middle of the overlap, so a word near a boundary is
// taken from the window that heard more of it.
import type { Word } from "./lines";

export const WINDOW = 30; // seconds the engine hears at once

export type Win = { start: number; end: number; keepFrom: number; keepTo: number };

/** Plan the windows for a clip of `total` seconds. One window when the clip fits in it. */
export function planWindows(total: number, seconds = WINDOW): Win[] {
  if (!(total > 0)) return [];
  if (total <= seconds) return [{ start: 0, end: total, keepFrom: 0, keepTo: Infinity }];
  const n = Math.ceil(total / seconds - 1e-9); const step = (total - seconds) / (n - 1);
  const wins: Win[] = Array.from({ length: n }, (_, i) => { const start = i === n - 1 ? total - seconds : +(i * step).toFixed(3); return { start, end: +(start + seconds).toFixed(3), keepFrom: 0, keepTo: Infinity }; });
  for (let i = 0; i < n; i++) {
    const prev = wins[i - 1], next = wins[i + 1];
    wins[i].keepFrom = prev ? +((wins[i].start + prev.end) / 2).toFixed(3) : 0;
    wins[i].keepTo = next ? +((next.start + wins[i].end) / 2).toFixed(3) : Infinity;
  }
  return wins;
}

/** Words from one window (timestamps relative to the window) → absolute words, keeping only the window's share. */
export function keepWindowWords(words: Word[], w: Win): Word[] {
  const out: Word[] = [];
  for (const x of words) {
    const start = x.start + w.start, end = Math.max(start, x.end + w.start);
    if (start < w.keepFrom || start >= w.keepTo) continue;
    out.push({ text: x.text, start: +start.toFixed(3), end: +Math.min(end, w.end).toFixed(3) });
  }
  return out;
}

// The model marks words late: measured against the voice's own loudness, word times fit best when moved 0.20 to 0.45 s earlier
// (two clips, 2026-09-19; design review 2 measured 0.20 to 0.36 s on the sample). A highlight that trails the voice reads as broken,
// one that leads slightly reads as in time, so every word is moved earlier by the smallest lag seen.
export const LEAD = 0.2;
/** Words moved earlier by `by` seconds, not before 0, order and lengths kept. */
export function earlier(words: Word[], by = LEAD): Word[] {
  return words.map((w) => { const start = Math.max(0, +(w.start - by).toFixed(3)); return { ...w, start, end: Math.max(start + 0.02, +(w.end - by).toFixed(3)) }; });
}
