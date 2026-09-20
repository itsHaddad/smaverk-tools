// Names: the one the person reads, and the one that lands in their downloads folder.

/** Seconds as a clock a person reads: 1:05, 12:04, 1:02:03. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** A length said out loud: "4 min 20 s", "48 s". */
export function spoken(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

/**
 * A long file name shown short, with the middle taken out and the ending kept.
 *
 * The ending matters: `recording.mov` and `recording.mp3` are different files to the person holding
 * them. The full name goes in a `title` so nothing is actually hidden.
 */
export function displayName(name: string, max = 34): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const keep = Math.max(6, max - ext.length - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(stem.length - tail) : ""}${ext}`;
}

const SAFE = /[^A-Za-z0-9-_]+/g;

/** The name of a file we hand back: the recording's name, the moment's place in it, and the format. */
export function outputName(sourceName: string, index: number, startS: number, ext: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, "").replace(SAFE, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const at = clock(startS).replace(/:/g, "-");
  return `${stem || `recording-${new Date().toISOString().slice(0, 10)}`}-${String(index).padStart(2, "0")}-at-${at}.${ext}`;
}

/** The name of the timeline file for a whole recording. */
export function timelineName(sourceName: string, ext: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, "").replace(SAFE, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${stem || `recording-${new Date().toISOString().slice(0, 10)}`}-moments.${ext}`;
}
