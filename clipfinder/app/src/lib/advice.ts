// advice.ts: what to say when a recording comes back with nothing.
//
// The cold user, 2026-09-21, on a seventeen-minute TED talk at the shortest length: it found nothing and
// answered "Try a shorter clip length." One minute IS the shortest; the button it pointed at does not
// exist. An instruction that cannot be followed is worse than no instruction, because the person spends
// their next minute looking for a control rather than deciding what to do.
//
// So the sentence names the lengths that are actually on the page, and never the one already chosen.

import { spoken } from "./naming";

/**
 * The lengths worth trying next, in the order they sit on the page, leaving out the one just tried.
 */
export function otherLengths(targetS: number, offered: readonly number[]): number[] {
  return offered.filter((s) => s !== targetS).sort((a, b) => a - b);
}

/**
 * What the page says when a recording held nothing together at the length asked for.
 *
 * It states what was actually looked for, and then the lengths that exist. No promise that another
 * length will find something: nobody has measured that it will, and on this material it is not always
 * true — a longer clip can hold together where a shorter one does not.
 */
export function nothingFoundLine(targetS: number, offered: readonly number[]): string {
  const rest = otherLengths(targetS, offered);
  const names = rest.map((s) => spoken(s));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  const held = `Nothing in this one stayed on a single subject for a whole ${spoken(targetS)}.`;
  return list ? `${held} Try ${list}.` : held;
}
