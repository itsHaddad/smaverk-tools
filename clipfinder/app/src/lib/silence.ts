// Where the talking stops.
//
// A moment that opens three words into a sentence sounds broken in a way anyone notices at once, so
// every boundary is moved to the nearest place the speaker actually stopped. The research tree got
// those places from the gaps between word timestamps, which works when the recogniser reports them.
// The recogniser this page ships does not: it returns text and no times, so its word positions are
// spread evenly across the window and the gaps between them are an artefact of that spreading rather
// than a silence.
//
// So the silences are taken from the sound instead, which is better than the gaps were: it is a real
// measurement rather than an inference, and it is free. The window has already been decoded to 16 kHz
// mono for the recogniser; one pass over it costs about a millisecond and nothing is kept but the
// times. An hour of talking leaves a few hundred numbers behind.

/** Frames of this length are the unit of loudness. Short enough to see a gap, long enough to be stable. */
export const FRAME_S = 0.02;

/** A quiet run shorter than this is a breath, not a break. Matches the research tree's PAUSE_S. */
export const MIN_SILENCE_S = 0.6;

export type Silence = { at: number; lengthS: number };

/**
 * Finds silences as windows of sound arrive, and keeps only the times.
 *
 * The threshold is set from the window itself — six per cent of its own loud level — because a quiet
 * recording and a loud one have nothing in common in absolute terms and the same fixed number would
 * call one of them silent throughout. The loud level is the ninety-fifth percentile rather than the
 * peak, so one door slam cannot raise the bar for the whole window.
 */
export class SilenceFinder {
  private readonly out: Silence[] = [];
  /** Seconds of quiet already running at the end of the last window, so a silence can cross a seam. */
  private carryS = 0;
  private rms: Float32Array = new Float32Array(0);

  constructor(
    private readonly sampleRate: number,
    private readonly minSilenceS = MIN_SILENCE_S,
  ) {}

  /** The silences found so far, in time order. */
  get silences(): Silence[] {
    return this.out;
  }

  /**
   * Feed one window of mono samples. `startS` is where the window's FIRST sample sits in the recording;
   * `fromS` is the point after which this window is authoritative, so overlapping sound is not measured
   * twice.
   */
  feed(samples: Float32Array, startS: number, fromS = startS): void {
    const per = Math.max(1, Math.round(FRAME_S * this.sampleRate));
    const frames = Math.floor(samples.length / per);
    if (!frames) return;
    if (this.rms.length < frames) this.rms = new Float32Array(frames);
    const rms = this.rms;
    for (let f = 0; f < frames; f++) {
      let acc = 0;
      const base = f * per;
      for (let i = 0; i < per; i++) {
        const v = samples[base + i]!;
        acc += v * v;
      }
      rms[f] = Math.sqrt(acc / per);
    }
    const sorted = Float32Array.prototype.slice.call(rms, 0, frames).sort();
    const loud = sorted[Math.min(frames - 1, Math.floor(frames * 0.95))]!;
    const threshold = Math.max(loud * 0.06, 1e-4);

    const skipFrames = Math.max(0, Math.round((fromS - startS) / FRAME_S));
    if (skipFrames > 0) this.carryS = 0; // a seam was skipped: whatever was running is not continuous
    let run = this.carryS;
    for (let f = skipFrames; f < frames; f++) {
      if (rms[f]! < threshold) {
        run += FRAME_S;
        continue;
      }
      // Speech again. The boundary belongs where it resumes, which is where a clip should open.
      if (run >= this.minSilenceS) this.push({ at: +(startS + f * FRAME_S).toFixed(2), lengthS: +run.toFixed(2) });
      run = 0;
    }
    this.carryS = run;
  }

  /** Close the last run, for a recording that ends in silence. */
  end(endS: number): void {
    if (this.carryS >= this.minSilenceS) this.push({ at: +endS.toFixed(2), lengthS: +this.carryS.toFixed(2) });
    this.carryS = 0;
  }

  private push(s: Silence): void {
    const last = this.out[this.out.length - 1];
    if (last && s.at <= last.at) return; // a seam can only ever move time forward
    this.out.push(s);
  }
}
