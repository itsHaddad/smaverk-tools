// fixture.mjs: a five-minute recording with a face and a voice, made from the other tools' own fixtures, so no new
// file of somebody else's has to be checked in. The picture is Vertical's moving-face clip, looped; the sound is the
// clip finder's six-minute talk (both public domain or CC, see their SOURCES.md). Five minutes is past the four the
// clip finder needs before it has anything to pick out.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeFixture(root, seconds = 300) {
  const out = join(tmpdir(), `clips-fixture-${seconds}.mp4`);
  if (existsSync(out)) return out;
  const face = join(root, "..", "..", "vertical", "app", "tests", "fixtures", "talk-moving-face.mp4");
  const talk = join(root, "..", "..", "clipfinder", "app", "tests", "fixtures", "talk6.mp3");
  for (const f of [face, talk]) if (!existsSync(f)) throw new Error(`fixture source missing: ${f}`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-stream_loop", "-1", "-i", face, "-i", talk, "-map", "0:v", "-map", "1:a", "-t", String(seconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]);
  return out;
}
