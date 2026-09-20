#!/usr/bin/env bun
// Build the job matrix and refuse the run if it would cost more runner time than it was given.
//
//   bun bench/asr/plan.ts --refs a,b --model tiny --slice-minutes 30 --budget-minutes 240
//
// The estimate is deliberately pessimistic. A run that finishes under budget costs nothing; a run that
// is stopped half way costs everything it already spent.

const SLOWDOWN: Record<string, number> = {
  tiny: 1,
  "tiny.en": 1,
  base: 1.9,
  small: 6,
  "moonshine-tiny": 0.8,
  "moonshine-base": 1.5,
};

/** Times real time for `tiny` on a two-core runner, measured rather than assumed. */
const TINY_REAL_TIME = 0.5;
/** Fetching and decoding the audio, plus the model download, before a second is transcribed. */
const OVERHEAD_MIN = 6;

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1]! : d;
};

// A reference is either `id` or `id:minutes`. The length matters: without it every recording is
// assumed to be the same size, and a three-hour podcast planned as a one-hour one is SILENTLY
// TRUNCATED to its first hour — transcripts that look fine and are missing two thirds of the show.
const refs = arg("refs", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [id, mins] = s.split(":");
    return { id: id!.trim(), minutes: mins ? Number(mins) : null };
  });
if (refs.some((r) => r.minutes !== null && !(r.minutes! > 0))) throw new Error("a reference has a non-positive length");
const model = arg("model", "tiny");
const sliceMin = Math.max(1, Number(arg("slice-minutes", "30")));
const budgetMin = Number(arg("budget-minutes", "240"));
if (!refs.length) throw new Error("--refs is empty");
if (!(model in SLOWDOWN)) throw new Error(`unknown model ${model}; known: ${Object.keys(SLOWDOWN).join(", ")}`);

// A reference given without a length falls back to this. Over-estimating costs one mostly-empty shard;
// under-estimating loses the end of the recording without saying so, which is far worse.
const ASSUMED_MIN = Number(arg("assumed-minutes", "60"));
const perJobMin = sliceMin * TINY_REAL_TIME * SLOWDOWN[model]! + OVERHEAD_MIN;

const include: { ref: string; from: number; to: number }[] = [];
for (const { id, minutes } of refs) {
  const lengthS = (minutes ?? ASSUMED_MIN) * 60;
  for (let from = 0; from < lengthS; from += sliceMin * 60)
    include.push({ ref: id, from, to: Math.min(lengthS, from + sliceMin * 60) });
}

const total = include.length * perJobMin;
if (total > budgetMin)
  throw new Error(
    `this run is estimated at ${Math.round(total)} runner minutes (${include.length} jobs x ${Math.round(perJobMin)} min) ` +
      `against a budget of ${budgetMin}. Raise --budget-minutes deliberately, or ask for fewer references or a smaller model.`,
  );

console.log(`matrix=${JSON.stringify({ include })}`);
console.error(`${include.length} jobs, about ${Math.round(perJobMin)} min each, ${Math.round(total)} runner minutes estimated`);
