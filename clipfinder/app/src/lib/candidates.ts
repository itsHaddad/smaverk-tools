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
  const { targetS, overshoot = 1.8, granularity = 0.5, snapToPauseS = 0, edgeS = 0, silences, ...segOpts } = opts;
  const minSectionS = segOpts.minSectionS ?? Math.min(45, targetS / 6);
  const tuned =
    granularity === null
      ? segOpts
      : { ...segOpts, minSectionS, cutoffSd: segOpts.cutoffSd ?? tuneCutoff(t, durationS, targetS, granularity, { ...segOpts, minSectionS }) };
  const { sections: cut, boundaryDepth } = segmentDetailed(t, durationS, tuned);
  const sections = snapToPauseS > 0 ? snapSections(cut, t, snapToPauseS, silences) : cut;
  const out: Candidate[] = [];
  for (let i = 0; i < sections.length; i++) {
    let j = i;
    let end = sections[i]!.endS;
    while (end - sections[i]!.startS < targetS && j + 1 < sections.length) {
      j++;
      end = sections[j]!.endS;
    }
    const len = end - sections[i]!.startS;
    if (len > targetS * overshoot) continue;
    if (len < targetS * 0.5) continue;
    if (edgeS > 0 && (sections[i]!.startS < edgeS || end > durationS - edgeS)) continue;
    out.push({
      startS: sections[i]!.startS,
      endS: end,
      startWord: sections[i]!.startWord,
      endWord: sections[j]!.endWord,
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
