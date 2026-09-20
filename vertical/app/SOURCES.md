# Where the media in dist/ comes from

- `dist/sample.mp4`, `dist/poster.jpg` (frame 0 of the sample), and the studio card's copies made by `captions/app/build.sh`:
  "Simple Soccer Drill For 1v1 Situations" by Coach Javi, https://www.youtube.com/watch?v=GoE-e8u-P1g , published under YouTube's
  "Creative Commons Attribution licence (reuse allowed)" (read from the video's metadata with yt-dlp on 2026-09-18; the uploader is the
  man on screen). Cut: 0:29 to 0:40.6 of the video (the tracker measures him moving across 0.33 to 0.56 of the width), 854x480, 25 fps, sound levelled to about -16 LUFS, mono AAC. He says: "…walk you
  through an exercise that you guys can do on your own. All you need is a soccer ball, a few cones and a goal to shoot on…".
  Chosen because the principal asked for a man who MOVES while talking, with his real voice; he crosses from the middle of the frame
  to the right and back. Credit on both pages that show it: "Sample clip: Coach Javi, CC BY" linking to the video. A courtesy note
  to the creator is a good idea before any paid promotion uses the clip.
  Earlier samples kept in scratch only: Wikitongues "David" (CC BY 3.0, voice, still), Mixkit 2956 and 52184 (silent).
  To replace: put the file at `dist/sample.mp4`, make the poster with `ffmpeg -y -i dist/sample.mp4 -frames:v 1 -vf scale=640:-1 -q:v 4 dist/poster.jpg`, push, run `../../ci.sh sample`.
- `dist/sample-track.json`: made from `dist/sample.mp4` by `tools/sample-track.mjs` (the tool's own tracker), on a runner via `ci.sh sample`.
- `tests/fixtures/`: see `tests/fixtures/SOURCES.md`.
