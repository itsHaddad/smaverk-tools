// Caption lines: words are grouped into fixed lines that stay on screen for their whole span, so text never slides
// word by word. Lines follow captioning practice rather than a word count alone (the principal, 2026-09-18: "ensure that the
// captioning and how many words and the kind of words shown is proper"):
//   1. A sentence end or a pause always ends a line; a comma ends one when the clause before it has at least two words.
//   2. A clause too long for one line is split into even parts, so no single word is left over at the end.
//   3. A line does not end on a word that belongs to the next one (a, the, to, and, your, is, very …).
//   4. A negation stays with what it negates: "nothing gets uploaded" is not cut after "nothing", so "gets uploaded." cannot stand alone.
//   5. Lines aim for 24 characters so the one-row styles draw them at full size; up to 28 is accepted when the other choice is a
//      single stranded word. A one-word line appears only when the speaker said one word (a sentence such as "Done.").
export type Word = { text: string; start: number; end: number };
export type Line = { ws: Word[]; idx: number[]; start: number; end: number };
export const LINE = { maxWords: 5, maxChars: 24, hardChars: 28, maxSeconds: 2.6, pauseSeconds: 0.6, holdSeconds: 0.4, wordTail: 0.15 };

const bare = (w: Word) => w.text.trim().toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
const WEAK = new Set(("a an the to of in on at for with from by as into onto over under about and or but so if that than because while " +
  "my your his her its our their this these those is are was were be been am i'm you're we're they're it's i you we they he she it " +
  "can could will would shall should may might must do does did have has had very really just right more most too quite").split(" "));
const NEG = new Set("not no nothing never none nobody nowhere neither nor without cannot".split(" "));
const isNeg = (w: Word) => { const b = bare(w); return NEG.has(b) || /n't$/.test(b); };
const chars = (ws: Word[]) => ws.reduce((n, w) => n + w.text.trim().length, 0) + Math.max(0, ws.length - 1);
const fits = (ws: Word[], limit = LINE.hardChars) => ws.length <= LINE.maxWords && chars(ws) <= limit && ws[ws.length - 1]!.end - ws[0]!.start <= LINE.maxSeconds;

/** Split one clause into k even parts, moving each cut to the best nearby place. Returns the cut positions (a cut after word p). */
function cuts(seg: Word[], k: number, strictNeg: boolean): number[] | null {
  const n = seg.length, out: number[] = []; let from = 0;
  for (let j = 1; j < k; j++) {
    const ideal = (j * n) / k; let best = -1, bestCost = Infinity;
    for (let p = Math.max(from, Math.floor(ideal) - 3); p <= Math.min(n - 2, Math.ceil(ideal) + 1); p++) {
      if (isNeg(seg[p]!) || (strictNeg && p > 0 && isNeg(seg[p - 1]!) && p < n - 1)) continue; // rule 4
      if (p + 1 - from < 1 || n - (p + 1) < 1) continue;
      const lonely = (p + 1 - from === 1 ? 1.5 : 0) + (n - (p + 1) === 1 ? 3 : 0); // a one-word line is a last resort
      const cost = Math.abs(p + 1 - ideal) + (WEAK.has(bare(seg[p]!)) ? 2.5 : 0) - (/[,;:]$/.test(seg[p]!.text.trim()) ? 1.5 : 0) + lonely;
      if (cost < bestCost) { bestCost = cost; best = p; }
    }
    if (best < 0) return null; out.push(best); from = best + 1;
  }
  return out;
}

function splitClause(seg: Word[]): Word[][] {
  if (fits(seg)) return [seg];
  const n = seg.length, dur = seg[n - 1]!.end - seg[0]!.start;
  const kMin = Math.max(2, Math.ceil(n / LINE.maxWords), Math.ceil(chars(seg) / LINE.maxChars), Math.ceil(dur / LINE.maxSeconds));
  // even parts first; a stranded single word is refused while any other split exists; the negation rule gives way last
  for (const [strictNeg, allowSingle] of [[true, false], [false, false], [true, true], [false, true]] as const) for (let k = kMin; k <= n; k++) {
    const c = cuts(seg, k, strictNeg); if (!c) continue;
    const parts: Word[][] = []; let a = 0; for (const p of [...c, n - 1]) { parts.push(seg.slice(a, p + 1)); a = p + 1; }
    if (parts.every((p) => (p.length === 1 ? allowSingle || chars(p) > LINE.hardChars : fits(p)))) return parts;
  }
  return seg.map((w) => [w]);
}

export function buildLines(words: Word[]): Line[] {
  // 1. clauses: sentence ends, pauses, and commas after at least two words
  const clauses: number[][] = []; let cur: number[] = [];
  words.forEach((w, i) => {
    const prev = cur.length ? words[cur[cur.length - 1]!]! : null;
    if (prev && (/[.!?]["')\]]?$/.test(prev.text.trim()) || w.start - prev.end > LINE.pauseSeconds || (/[,;:]$/.test(prev.text.trim()) && cur.length >= 2))) { clauses.push(cur); cur = []; }
    cur.push(i);
  });
  if (cur.length) clauses.push(cur);
  // a one-word clause after a comma ("Well, …") joins what follows when the pair still fits
  for (let c = 0; c < clauses.length - 1; c++) { const a = clauses[c]!, b = clauses[c + 1]!; if (a.length === 1 && !/[.!?]$/.test(words[a[0]!]!.text.trim()) && words[b[0]!]!.start - words[a[0]!]!.end <= LINE.pauseSeconds) { clauses.splice(c, 2, [...a, ...b]); c--; } }
  // 2–5. lines inside each clause
  const out: Line[] = [];
  for (const cl of clauses) { let at = 0; for (const part of splitClause(cl.map((i) => words[i]!))) { const idx = cl.slice(at, at + part.length); at += part.length; out.push({ ws: part, idx, start: part[0]!.start, end: part[part.length - 1]!.end }); } }
  return out;
}

/** The line to show at time t (held until the next line starts, or a short tail after its last word), with the spoken word's index. */
export function lineAt(lines: Line[], t: number, span = 6): { ws: Word[]; cur: number; idx: number[] } | null {
  const li = lines.findIndex((l, k) => t >= l.start && t < (lines[k + 1]?.start ?? l.end + LINE.holdSeconds)); if (li < 0) return null;
  const l = lines[li]!; const cur = l.ws.findIndex((w) => t >= w.start && t < w.end + LINE.wordTail);
  const ws = span < l.ws.length ? l.ws.slice(0, span) : l.ws; return { ws, cur: Math.min(cur, ws.length - 1), idx: l.idx.slice(0, ws.length) };
}
