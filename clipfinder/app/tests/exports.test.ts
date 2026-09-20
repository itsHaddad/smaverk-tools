// The paid half of the product is a file another program has to accept, so the shape of that file is
// tested here rather than looked at. What cannot be tested from this machine — whether Premiere opens
// it — is written down in the app's README instead of claimed on the page.
import { test, expect } from "bun:test";
import { timecode, frames, edl, csvMarkers, fcp7Xml, fcpXml, FORMATS, type ExportMedia } from "../src/lib/exports";

const media: ExportMedia = { name: "artemis-ii-the-crew.mp3", durationS: 3878.1, fps: 30, hasVideo: false, hasAudio: true };
const moments = [
  { startS: 120, endS: 420, why: ["One subject, held for 5 min"], opening: "so the first thing…" },
  { startS: 900.5, endS: 1200.5, why: ["Explains itself"], opening: "what people get wrong…" },
];

test("timecode counts hours, minutes, seconds and frames", () => {
  expect(timecode(0, 30)).toBe("00:00:00:00");
  expect(timecode(1, 30)).toBe("00:00:01:00");
  expect(timecode(3661.5, 25)).toBe("01:01:01:12");
  // A frame that has not finished has not happened: 59.999 s is the last frame of second 59, not minute 1.
  expect(timecode(59.999, 25)).toBe("00:00:59:24");
});

test("a frame count never lands on the frame rate itself", () => {
  // 24.99 frames at 25 fps is frame 24 of that second, not frame 25 of the one before it.
  for (let i = 0; i < 2000; i++) {
    const tc = timecode(i / 7.3, 25);
    expect(Number(tc.slice(-2))).toBeLessThan(25);
  }
});

test("frames() is the whole number of frames at the rate", () => {
  expect(frames(2, 30)).toBe(60);
  expect(frames(0.5, 24)).toBe(12);
});

test("an EDL lays the moments end to end on the record side", () => {
  const out = edl("Artemis", media, moments);
  const events = out.split("\n").filter((l) => /^\d{3} /.test(l));
  expect(events).toHaveLength(2);
  expect(out).toContain("TITLE: Artemis");
  expect(out).toContain("FCM: NON-DROP FRAME");
  // Audio-only source: no video channel is claimed.
  expect(events[0]).toContain(" AA  ");
  // Source in/out are the moment; record in/out start at zero and follow on.
  expect(events[0]).toContain("00:02:00:00 00:07:00:00 00:00:00:00 00:05:00:00");
  expect(events[1]).toContain("00:05:00:00 00:10:00:00");
  expect(out).toContain("* FROM CLIP NAME: ARTEMIS-II-THE-CREW.MP3");
});

test("an EDL reel name is eight characters of A-Z and 0-9", () => {
  const out = edl("x", { ...media, name: "a very long name with spaces.mp3" }, moments);
  const reel = out.split("\n").find((l) => /^001 /.test(l))!.slice(4, 12).trim();
  expect(reel).toMatch(/^[A-Z0-9]{1,8}$/);
});

test("the marker list carries the times and the reasons", () => {
  const rows = csvMarkers(media, moments).trim().split("\n");
  expect(rows[0]).toBe("start,end,length,start_seconds,end_seconds,why,opening");
  expect(rows).toHaveLength(3);
  expect(rows[1]).toContain("00:02:00:00");
  expect(rows[1]).toContain("One subject, held for 5 min");
});

test("a comma or a quote in a reason cannot break the marker list", () => {
  const row = csvMarkers(media, [{ startS: 0, endS: 60, why: ['he said "no, really"'], opening: "a, b" }]).trim().split("\n")[1]!;
  expect(row).toContain('"he said ""no, really"""');
  expect(row.match(/,/g)!.length).toBeGreaterThan(5);
});

test("the Premiere and Resolve timeline holds one item per moment", () => {
  const xml = fcp7Xml("Artemis", media, moments);
  expect(xml.startsWith("<?xml")).toBe(true);
  expect(xml.match(/<clipitem/g)).toHaveLength(2); // audio-only: one audio item per moment
  expect(xml).toContain("<duration>116343</duration>"); // 3878.1 s at 30 fps
  expect(xml).toContain("<in>3600</in>"); // 120 s
  expect(xml).toContain("<out>12600</out>"); // 420 s
  expect(xml).toContain("<start>0</start>");
  expect(xml).toContain("<end>9000</end>"); // the first moment runs 300 s on the timeline
});

test("a video source gets a video item and an audio item per moment", () => {
  const xml = fcp7Xml("v", { ...media, hasVideo: true }, moments);
  expect(xml.match(/<clipitem/g)).toHaveLength(4);
});

test("the Final Cut timeline uses rational times on a common timebase", () => {
  const xml = fcpXml("Artemis", media, moments);
  expect(xml).toContain('<fcpxml version="1.9">');
  expect(xml.match(/<asset-clip/g)).toHaveLength(2);
  expect(xml).toContain('start="360000/3000s"'); // 120 s
  expect(xml).toContain('duration="900000/3000s"'); // 300 s
  expect(xml).toContain('offset="0/3000s"');
});

test("every name that reaches a file is escaped, so a stray angle bracket cannot close a tag", () => {
  const hostile = { ...media, name: 'a & b <script>"x".mp3' };
  for (const xml of [fcp7Xml("t", hostile, moments), fcpXml("t", hostile, moments)]) {
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;script&gt;");
  }
});

test("a moment shorter than one frame is dropped rather than written as a zero-length item", () => {
  const out = edl("t", media, [{ startS: 10, endS: 10.001, why: [], opening: "" }]);
  expect(out.split("\n").filter((l) => /^\d{3} /.test(l))).toHaveLength(0);
});

test("an edit list puts no comment before its first event", () => {
  // OpenTimelineIO refuses the whole file with "Unknown event type" when a comment sits above event 001
  // (2026-09-20). The frame-rate note therefore rides on the first event, not in the header.
  const lines = edl("t", media, moments).split("\n");
  const firstEvent = lines.findIndex((l) => /^\d{3} /.test(l));
  const firstComment = lines.findIndex((l) => l.startsWith("*"));
  expect(firstEvent).toBeGreaterThan(0);
  expect(firstComment).toBeGreaterThan(firstEvent);
});

test("an edit list says what frame rate it was written at", () => {
  // The format carries no rate, so whatever opens the file reads these timecodes at its own.
  expect(edl("t", media, moments)).toContain("* TIMELINE FRAME RATE 30");
  expect(edl("t", { ...media, fps: 25 }, moments)).toContain("* TIMELINE FRAME RATE 25");
});

test("every format says, in a sentence, what the person just got", () => {
  for (const [name, f] of Object.entries(FORMATS)) {
    const line = f.says(media, 4);
    expect(line, name).toMatch(/^4 moments/);
    expect(line.length, name).toBeGreaterThan(30);
  }
  expect(FORMATS.edl.says(media, 4), "the edit list names the rate the person must set").toContain("30 frames a second");
});
