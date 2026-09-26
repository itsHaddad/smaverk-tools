// plan.ts: the decisions Clips makes between finding the moments and making the clips, with no browser in them.
//
// The finding is the clip finder's own (its worker, unchanged), and so are its clock, its names and its rule
// for where a sentence ends. What is new here is the part only this tool has: which moments are kept by
// default, the 90-second cap and where a capped clip ends, and how the sound of a cut lines up with its picture.

import { clock, spoken, outputName } from "../../../../clipfinder/app/src/lib/naming";
import { endsThought } from "../../../../clipfinder/app/src/lib/edges";

/**
 * The longest clip this tool makes. Captions' own measurement (the clip-length report, 2026-09-19) put its
 * speech engine at 1968 MB of peak memory on a five-minute clip, against a 1–1.5 GB phone tab. Ninety seconds
 * is a length a phone can carry, and it is the length the places these clips are posted to favour. The page says so.
 */
export const MAX_CLIP_S = 90;
/** The shortest clip the trim handles allow: the clip finder's own floor. */
export const MIN_CLIP_S = 20;
/** How many of the strongest moments are ticked when the list arrives. */
export const DEFAULT_KEEP = 3;
/** How far a trim handle reaches from where the finder put the edge, each way. The clip finder's reach. */
export const REACH_S = 120;
/** A clip that ends on a sentence keeps a breath after the last word. */
const TAIL_S = 0.3;

export type Moment = { startS: number; endS: number; why: string[]; opening: string };
export type Kept = Moment & {
  /** Whether the person wants this one made. */
  keep: boolean;
  /** Whether the cap shortened it. */
  capped: boolean;
  /** Where the finder ended it, before the cap. */
  foundEndS: number;
};

/** A moment's end, held to the cap. Seconds are whole where the cap applies, so the page and the file agree. */
export function capEnd(startS: number, endS: number, max = MAX_CLIP_S): { endS: number; capped: boolean } {
  if (endS - startS <= max) return { endS, capped: false };
  return { endS: Math.floor(startS + max), capped: true };
}

/** The finder's list, strongest first, as the list the person ticks: the first few kept, every one capped. */
export function planMoments(moments: Moment[], keep = DEFAULT_KEEP): Kept[] {
  return moments.map((m, i) => {
    const c = capEnd(m.startS, m.endS);
    return { ...m, endS: c.endS, capped: c.capped, foundEndS: m.endS, keep: i < keep };
  });
}

export const keptCount = (list: { keep: boolean }[]) => list.filter((m) => m.keep).length;

/** Where the trim handles leave a clip: inside the recording, no shorter than the floor, no longer than the cap. */
export function trimTo(startS: number, endS: number, totalS: number, max = MAX_CLIP_S, min = MIN_CLIP_S): { startS: number; endS: number } {
  const start = Math.max(0, Math.min(startS, totalS - min));
  const end = Math.max(start + min, Math.min(endS, totalS, start + max));
  return { startS: start, endS: end };
}

/** The range each trim handle offers for a clip, on the recording's clock. */
export function trimBounds(m: { startS: number; endS: number }, totalS: number): { start: { min: number; max: number }; end: { min: number; max: number } } {
  return {
    start: { min: Math.max(0, Math.round(m.startS) - REACH_S), max: Math.round(m.endS) - MIN_CLIP_S },
    end: { min: Math.round(m.startS) + MIN_CLIP_S, max: Math.min(Math.round(totalS), Math.round(m.startS) + MAX_CLIP_S) },
  };
}

/**
 * Where a clip that was cut to the cap ends: after the last finished sentence that fits, heard in the clip's
 * own words. The clip finder ends every moment on a finished sentence (its clean-edges rule); cutting at the
 * cap would undo that, so the end moves back to the last one before it. With none after the floor, the cap stands.
 */
export function sentenceEnd(words: { text: string; start: number; end: number }[], capS: number, minS = MIN_CLIP_S): number {
  let best = capS;
  let found = false;
  for (const w of words) {
    if (w.end < minS || w.end + TAIL_S > capS) continue;
    if (endsThought(w.text)) {
      best = w.end + TAIL_S;
      found = true;
    }
  }
  return found ? best : capS;
}

/**
 * Sound decoded from a cut, moved onto the clip's clock. A cut copied without re-encoding starts at the key
 * frame before the moment, so its first sound can sit a little before zero; the picture is saved from zero.
 * Words heard in sound that is not on the same clock as the picture would be drawn early or late.
 */
export function alignToZero(samples: Float32Array, firstS: number, rate: number): Float32Array {
  const shift = Math.round(firstS * rate);
  if (shift === 0) return samples;
  if (shift < 0) return samples.subarray(Math.min(samples.length, -shift));
  const out = new Float32Array(shift + samples.length);
  out.set(samples, shift);
  return out;
}

/** The file a clip is saved as: the recording's name, its place in the list and where it starts. */
export const clipName = (sourceName: string, index: number, startS: number) => outputName(sourceName, index, startS, "mp4");

/** The free version saves one clip on this device; the paid version saves every clip. */
export const mayFreeSave = (licensed: boolean, freeSaved: number) => licensed || freeSaved < 1;

/** The line under a finished clip. */
export const madeLine = (lengthS: number, fromS: number, capped: boolean) => `${spoken(lengthS)} from ${clock(fromS)}.${capped ? " Cut to 90 seconds." : ""}`;
