// Output file names: the clip's own name, kept as it is, plus "-captions". Only the extension goes, and characters no
// file system accepts become "-". A clip with no usable name at all gets a dated "clip-…" name.
export function outputBase(name: string, now: Date = new Date()): string {
  let b = name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+|[\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim().replace(/^[-. ]+|[-. ]+$/g, "");
  if (!/[\p{L}\p{N}]/u.test(b)) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `clip-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  }
  return b.slice(0, 80);
}
export const outputName = (name: string, ext: string, now?: Date) => `${outputBase(name, now)}-captions.${ext}`;

/** A file name that fits a box: shortened in the middle so the start and the ending (with the extension) both stay readable. */
export function displayName(name: string, max = 36): string {
  const n = name.trim(); if (n.length <= max) return n;
  const tail = Math.min(15, Math.floor(max * 0.4)); const head = max - tail - 1; // the tail keeps "-captions.mp4" whole at the usual widths
  return n.slice(0, head).trimEnd() + "…" + n.slice(-tail).trimStart();
}
/** The same, but against a real measure: the longest middle-shortened form for which `fits(text)` is true (the page passes the box width and font). */
export function fitName(name: string, fits: (text: string) => boolean, minTail = 13): string {
  const n = name.trim(); if (fits(n)) return n;
  const tail = Math.min(minTail, Math.floor(n.length / 2));
  for (let head = n.length - tail - 1; head >= 3; head--) { const t = n.slice(0, head).trimEnd() + "…" + n.slice(-tail).trimStart(); if (fits(t)) return t; }
  return n.slice(0, 3) + "…" + n.slice(-tail);
}
