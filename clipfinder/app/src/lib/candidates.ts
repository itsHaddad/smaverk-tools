// From topic boundaries to things a person could actually be shown.
//
// A section is where the subject holds. A clip is a section cut to a length people watch. They are not
// the same object: TextTiling on a two-hour recording returns sections from forty seconds to six
// minutes, while the people who make those recordings publish eight- to twelve-minute clips. So a
// candidate is a RUN of consecutive sections, starting at a topic boundary and extending until it
// reaches the length being asked for.
//
// Starting every candidate at a boundary is the whole bet. The first version of this tool proposed
// windows wherever the room got loud, and opened talks on applause; it scored 9.3% against random's
// 31.9% and was thrown away. A candidate here can only begin where the subject begins.

import { pauses, snap, type Pause } from "./pause";
import { segment, segmentDetailed, type Section, type SegmentOptions } from "./segment";
import { wordIndexAt, type Transcript } from "./words";

export type Candidate = {
  startS: number;
  endS: number;
  startWord: number;
  endWord: number;
  /** How many sections it spans, so a feature can ask how many subjects it crosses. */
  sections: number;
  /** Index of the section it starts at, for features that look at what came before. */
  fromSection: number;
};

export type CandidateOptions = SegmentOptions & {
  /** How long the wanted clips run. Candidates grow until they reach it. */
  targetS: number;
  /** A candidate may overshoot the target by this much before it is rejected as two subjects. */
  overshoot?: number;
  /** Tune the boundary cutoff so sections come out around this fraction of the target length. */
  granularity?: number | null;
  /** Move each boundary to the nearest silence within this many seconds. Zero disables it. */
  snapToPauseS?: number;
  /**
   * Seconds at each end of the recording that a candidate may not open or close inside.
   *
   * A show's opening and its closing are not its content: theme music, the title read out, where to find
   * the guest. The kill test measured that the first version of this tool put 35% of its moments in the
   * first or last twentieth of a recording against 3% of the creators' own, and the first sample built
   * for the page opened two of its five moments on a podcast's theme music.
   *
   * Measured on the fourteen recordings that matter (`clipfinder/text/bench/edges.ts`): the margin is
   * +8.0 points with the rule and +8.0 without it — on that corpus the rule takes away candidates that
   * were never picked anyway. It costs 1 creator clip in 72. It is kept because those fourteen are talks
   * and interviews that begin with content, and podcasts do not.
   */
  edgeS?: number;
  /**
   * Where the talking stopped, measured from the sound itself (`silence.ts`). When it is absent the
   * gaps between word timestamps are used instead, which is what the research tree measures on caption
   * tracks. The recogniser this page ships reports no word times, so the page always passes this.
   */
  silences?: Pause[];
  /**
   * Let a run end at a pause INSIDE a section, within this many seconds of the target, when no
   * whole-section run fits under the cap. Zero discards the run instead, which is what shipped first.
   *
   * A candidate being whole sections is why a SHORT recording could come back with nothing at all. At
   * the one-minute setting the median section is 118 s against a cap of 108 s, so 55.2% of sections
   * cannot produce a candidate on their own; a long recording has enough of them that some fit, a
   * short one may have none. Measured by truncating all 28 ground-truth recordings
   * (`clipfinder/text/bench/moments.md`): at ten minutes the one-minute setting returned nothing for
   * **6 of 28** recordings, at fifteen minutes 4 of 28, at twenty 1 of 28 — and **0 of 28 at every
   * length with this on**. A cold user's 17:31 talk sat exactly in that band and got the empty result.
   *
   * It is not a trade: on the fourteen recordings that matter the margin against darts is +8.1 with it
   * and +8.0 without, per-show +9.7/+11.4/−0.3 against +9.7/+11.0/−0.3, and it brings one more creator
   * clip within reach of the shortlist rather than losing any.
   *
   * The subject still has to START at a topic boundary — that is the bet this whole funnel rests on.
   * Nothing ever said it had to run to the end of one.
   */
  endInsideS?: number;
};

/**
 * Pick the boundary cutoff that makes sections about `fraction` of a clip long.
 *
 * A fixed cutoff cannot serve both shapes of recording. Hearst's mean − sd/2 gives a two-hour podcast
 * 35 sections of about four minutes, which is right when the clips wanted are eight minutes. The same
 * cutoff gives a 50-minute talk 10 sections of five and a half minutes when the clips wanted are three
 * — sections longer than the clips they are meant to contain, so the talk yields two candidates and
 * finds nothing. Bisection, six segmentations rather than the sixteen a linear scan cost.
 */
export function tuneCutoff(t: Transcript, durationS: number, targetS: number, fraction: number, segOpts: SegmentOptions): number {
  const want = targetS * fraction;
  const medianAt = (sd: number) => {
    const lens = segment(t, durationS, { ...segOpts, cutoffSd: sd })
      .map((s) => s.endS - s.startS)
      .sort((a, b) => a - b);
    return lens[lens.length >> 1] ?? durationS;
  };
  const LO = -1.5;
  const HI = 2.0;
  if (medianAt(LO) >= want) return LO;
  if (medianAt(HI) <= want) return HI;
  let lo = LO;
  let hi = HI;
  for (let i = 0; i < 4; i++) {
    const mid = (lo + hi) / 2;
    if (medianAt(mid) < want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * One candidate per topic boundary: start there, add whole sections until the target length is reached.
 * A candidate that would have to swallow more than `overshoot` times the target is dropped — the
 * subject at that boundary runs longer than the clip being asked for — and so is one that never got
 * close, so the tail of a recording produces nothing rather than a stub.
 */
export function candidates(
  t: Transcript,
  durationS: number,
  opts: CandidateOptions,
): { sections: Section[]; candidates: Candidate[]; boundaryDepth: number[] } {
  const { targetS, overshoot = 1.8, granularity = 0.5, snapToPauseS = 0, edgeS = 0, endInsideS = 0, silences, ...segOpts } = opts;
  const minSectionS = segOpts.minSectionS ?? Math.min(45, targetS / 6);
  const tuned =
    granularity === null
      ? segOpts
      : { ...segOpts, minSectionS, cutoffSd: segOpts.cutoffSd ?? tuneCutoff(t, durationS, targetS, granularity, { ...segOpts, minSectionS }) };
  const { sections: cut, boundaryDepth } = segmentDetailed(t, durationS, tuned);
  const sections = snapToPauseS > 0 ? snapSections(cut, t, snapToPauseS, silences) : cut;
  const out: Candidate[] = [];
  const ps = endInsideS > 0 ? (silences ?? pauses(t.words)) : [];
  const floor = targetS * 0.5;
  const cap = targetS * overshoot;
  for (let i = 0; i < sections.length; i++) {
    const startS = sections[i]!.startS;
    let j = i;
    let end = sections[i]!.endS;
    while (end - startS < targetS && j + 1 < sections.length) {
      j++;
      end = sections[j]!.endS;
    }
    let len = end - startS;
    let endWord = sections[j]!.endWord;
    if (len > cap) {
      // No whole-section run fits under the cap. Either drop it, or stop at a pause inside the
      // section this run ends in, so a short recording still gets an answer.
      if (endInsideS <= 0) continue;
      const { at, snapped } = snap(startS + targetS, ps, endInsideS);
      const cutAt = snapped ? at : startS + targetS;
      if (cutAt - startS < floor) continue;
      end = cutAt;
      len = end - startS;
      endWord = Math.max(sections[i]!.startWord, wordIndexAt(t.words, cutAt));
      while (j > i && sections[j]!.startS >= end) j--;
    }
    if (len < floor) continue;
    // The opening is counted from the first word, not the first second of the file: a video that starts on a
    // minute of silence and a countdown (the page's own sample, 2026-09-22: speech from 0:58, the room still
    // settling) would otherwise have its opening chatter treated as content. Identical wherever speech starts at once.
    if (edgeS > 0 && (startS < (t.words[0]?.t ?? 0) + edgeS || end > durationS - edgeS)) continue;
    out.push({
      startS,
      endS: end,
      startWord: sections[i]!.startWord,
      endWord,
      sections: j - i + 1,
      fromSection: i,
    });
  }
  return { sections, candidates: out, boundaryDepth };
}

/**
 * Move every section start (but not the recording's own start) to the nearest silence, keeping the
 * sections contiguous so the shortlist still covers the recording end to end.
 */
export function snapSections(sections: Section[], t: Transcript, windowS: number, silences?: Pause[]): Section[] {
  const ps = silences ?? pauses(t.words);
  const out = sections.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    const { at, snapped } = snap(out[i]!.startS, ps, windowS);
    if (!snapped || at <= out[i - 1]!.startS || at >= out[i]!.endS) continue;
    out[i]!.startS = at;
    out[i]!.startWord = wordIndexAt(t.words, at);
    out[i - 1]!.endS = at;
    out[i - 1]!.endWord = Math.max(out[i - 1]!.startWord, out[i]!.startWord - 1);
  }
  return out;
}
