// What the person takes away: the found moments as a file their editing program can open.
//
// Four shapes, because editors do not agree on one:
//
//   .edl     CMX3600, a plain text assembly. Resolve, Premiere, Avid and almost anything older read it.
//   .xml     the Final Cut 7 interchange, which is what Premiere and Resolve import as a timeline.
//   .fcpxml  Final Cut Pro's own.
//   .csv     the list itself, for notes or a spreadsheet.
//
// Everything here is pure text built from numbers, so it is tested rather than eyeballed. What these
// tests CANNOT show is whether Premiere opens the result — that needs Premiere. The app's README says
// so plainly and the page does not claim more than that.
//
// Times are frames. A frame that has not finished has not happened, so every conversion floors.

export type ExportMedia = {
  /** The file the person chose, by name. Its path never leaves the device, so only the name travels. */
  name: string;
  durationS: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
};

export type ExportMoment = { startS: number; endS: number; why: string[]; opening: string };

export const frames = (seconds: number, fps: number): number => Math.floor(seconds * fps + 1e-6);

export function timecode(seconds: number, fps: number): string {
  const f = Math.max(0, frames(seconds, fps));
  const pad = (n: number) => String(n).padStart(2, "0");
  return [Math.floor(f / (3600 * fps)), Math.floor(f / (60 * fps)) % 60, Math.floor(f / fps) % 60, f % fps].map(pad).join(":");
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

/** Moments long enough to be a frame, in time order, as frame counts. */
function events(media: ExportMedia, moments: ExportMoment[]) {
  const out: { m: ExportMoment; inF: number; outF: number; recF: number; lenF: number }[] = [];
  let rec = 0;
  for (const m of [...moments].sort((a, b) => a.startS - b.startS)) {
    const inF = frames(m.startS, media.fps);
    const outF = frames(m.endS, media.fps);
    const lenF = outF - inF;
    if (lenF < 1) continue;
    out.push({ m, inF, outF, recF: rec, lenF });
    rec += lenF;
  }
  return out;
}

/**
 * CMX3600. The reel name is eight characters of A-Z and 0-9 because that is what the format allows and
 * what the older programs that still read it will accept; the real file name goes on the comment line.
 *
 * An edit list does not carry its frame rate. Whatever opens it reads these timecodes at ITS OWN rate, so
 * the same file lands in a different place on a 25 fps timeline than on a 30 fps one. Found on 2026-09-20
 * by handing the file to OpenTimelineIO, which defaults to 24 and put a 900.5 s moment at 900.625 s. The
 * rate is therefore written into the file as a comment and said out loud when the file is saved; the
 * Final Cut 7 XML carries its own timebase and is the one to reach for first.
 */
export function edl(title: string, media: ExportMedia, moments: ExportMoment[]): string {
  const reel = (baseName(media.name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "CLIP") as string;
  const chan = media.hasVideo ? (media.hasAudio ? "AA/V" : "V") : "AA";
  const tc = (f: number) => timecode(f / media.fps, media.fps);
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  for (const [i, e] of events(media, moments).entries()) {
    lines.push(
      `${String(i + 1).padStart(3, "0")}  ${reel.padEnd(8)} ${chan.padEnd(6)} C        ` +
        `${tc(e.inF)} ${tc(e.outF)} ${tc(e.recF)} ${tc(e.recF + e.lenF)}`,
    );
    lines.push(`* FROM CLIP NAME: ${media.name.toUpperCase()}`);
    // A comment before the first event is not a legal edit list — OpenTimelineIO refuses the whole file
    // with "Unknown event type" (measured 2026-09-20). So the rate note rides on the first event.
    if (i === 0) lines.push(`* TIMELINE FRAME RATE ${media.fps}: SET YOUR TIMELINE TO IT OR THESE TIMES MOVE`);
    for (const why of e.m.why) lines.push(`* COMMENT: ${why}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The list itself. Every field is quoted, so a comma or a quotation mark in a reason cannot break a row. */
export function csvMarkers(media: ExportMedia, moments: ExportMoment[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = [["start", "end", "length", "start_seconds", "end_seconds", "why", "opening"].join(",")];
  for (const { m, inF, outF, lenF } of events(media, moments)) {
    rows.push(
      [
        timecode(inF / media.fps, media.fps),
        timecode(outF / media.fps, media.fps),
        timecode(lenF / media.fps, media.fps),
        m.startS.toFixed(2),
        m.endS.toFixed(2),
        m.why.join("; "),
        m.opening,
      ]
        .map((v) => cell(String(v)))
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

/**
 * The Final Cut 7 interchange: what Premiere Pro and DaVinci Resolve import as a timeline.
 *
 * The file reference carries the name only. There is no path, because there is no path to give — the
 * file never left the device and the page is not allowed to know where it sits. Both programs ask for
 * the file once on import and then relink the whole timeline.
 */
export function fcp7Xml(title: string, media: ExportMedia, moments: ExportMoment[]): string {
  const durF = frames(media.durationS, media.fps);
  const evs = events(media, moments);
  const total = evs.reduce((n, e) => n + e.lenF, 0);
  const file = `<file id="source"><name>${xmlEscape(media.name)}</name><duration>${durF}</duration>` +
    `<rate><timebase>${media.fps}</timebase><ntsc>FALSE</ntsc></rate>` +
    `<media>${media.hasVideo ? "<video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video>" : ""}` +
    `${media.hasAudio ? "<audio><channelcount>2</channelcount></audio>" : ""}</media></file>`;

  const item = (e: (typeof evs)[number], i: number, kind: "video" | "audio") =>
    `<clipitem id="${kind}-${i + 1}"><name>${xmlEscape(`${i + 1} · ${e.m.opening || media.name}`)}</name>` +
    `<duration>${durF}</duration><rate><timebase>${media.fps}</timebase><ntsc>FALSE</ntsc></rate>` +
    `<start>${e.recF}</start><end>${e.recF + e.lenF}</end><in>${e.inF}</in><out>${e.outF}</out>` +
    `${i === 0 && kind === (media.hasVideo ? "video" : "audio") ? file : '<file id="source"/>'}` +
    `${kind === "audio" ? "<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>" : ""}` +
    (e.m.why.length ? `<comments><mastercomment1>${xmlEscape(e.m.why.join(" · "))}</mastercomment1></comments>` : "") +
    `</clipitem>`;

  const videoTrack = media.hasVideo ? `<video><track>${evs.map((e, i) => item(e, i, "video")).join("")}</track></video>` : "";
  const audioTrack = media.hasAudio ? `<audio><track>${evs.map((e, i) => item(e, i, "audio")).join("")}</track></audio>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">` +
    `<sequence><name>${xmlEscape(title)}</name><duration>${total}</duration>` +
    `<rate><timebase>${media.fps}</timebase><ntsc>FALSE</ntsc></rate>` +
    `<media>${videoTrack}${audioTrack}</media></sequence></xmeml>\n`
  );
}

/**
 * Final Cut Pro's own format. Times are rational numbers over a common timebase rather than frames,
 * which is the one thing about this format that catches people out.
 */
export function fcpXml(title: string, media: ExportMedia, moments: ExportMoment[]): string {
  const TB = 3000;
  const t = (seconds: number) => `${Math.round(seconds * TB)}/${TB}s`;
  const evs = events(media, moments);
  const clips = evs
    .map(
      (e, i) =>
        `<asset-clip ref="r2" offset="${t(e.recF / media.fps)}" name="${xmlEscape(`${i + 1} · ${e.m.opening || media.name}`)}" ` +
        `start="${t(e.inF / media.fps)}" duration="${t(e.lenF / media.fps)}"` +
        (e.m.why.length ? `><note>${xmlEscape(e.m.why.join(" · "))}</note></asset-clip>` : "/>"),
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9">` +
    `<resources><format id="r1" name="FFVideoFormat1080p${media.fps}" frameDuration="${TB / media.fps}/${TB}s" width="1920" height="1080"/>` +
    `<asset id="r2" name="${xmlEscape(baseName(media.name))}" start="0s" duration="${t(media.durationS)}" ` +
    `hasVideo="${media.hasVideo ? 1 : 0}" hasAudio="${media.hasAudio ? 1 : 0}" audioChannels="2" format="r1">` +
    `<media-rep kind="original-media" src="${xmlEscape(media.name)}"/></asset></resources>` +
    `<library><event name="Clip finder"><project name="${xmlEscape(title)}">` +
    `<sequence format="r1" tcStart="0s" tcFormat="NDF"><spine>${clips}</spine></sequence>` +
    `</project></event></library></fcpxml>\n`
  );
}

export type Format = "edl" | "premiere" | "finalcut" | "csv";

/** "1 moments as an edit list" was on screen for a cold user, 2026-09-21. One place counts, everywhere. */
export const moments = (n: number) => `${n} moment${n === 1 ? "" : "s"}`;

/** One place that knows what each format is called, what it produces and what it is named on disk. */
export const FORMATS: Record<Format, { label: string; ext: string; type: string; says: (m: ExportMedia, n: number) => string; build: (title: string, m: ExportMedia, x: ExportMoment[]) => string }> = {
  premiere: {
    label: "Premiere · Resolve",
    ext: "xml",
    type: "application/xml",
    says: (_m, n) => `${moments(n)} as a Final Cut 7 timeline, the format Premiere Pro and DaVinci Resolve import. Point it at your recording when it asks.`,
    build: fcp7Xml,
  },
  finalcut: {
    label: "Final Cut",
    ext: "fcpxml",
    type: "application/xml",
    says: (_m, n) => `${moments(n)} as an FCPXML timeline, the format Final Cut Pro imports. Point it at your recording when it asks.`,
    build: fcpXml,
  },
  edl: {
    label: "Edit list",
    ext: "edl",
    type: "text/plain",
    // An edit list holds no frame rate, so the one thing the person must do is in the sentence they read.
    says: (m, n) => `${moments(n)} as an edit list, which almost any editor reads. Set the timeline to ${m.fps} frames a second first, or the times move.`,
    build: edl,
  },
  csv: {
    label: "Just the list",
    ext: "csv",
    type: "text/csv",
    says: (_m, n) => `${moments(n)} with their times and reasons, for a spreadsheet or your notes.`,
    build: (_t, m, x) => csvMarkers(m, x),
  },
};
