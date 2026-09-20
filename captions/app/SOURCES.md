# Where the media in dist/ comes from

- `dist/sample.mp4`, `dist/poster.webp`, `dist/sample-words.json`, and the studio card that plays them (`dist/studio.html`):
  "How To Be Confident On Camera | Tips for Content Creators" by Peter Kramm, https://www.youtube.com/watch?v=96eBO8N3qn4 , published under
  YouTube's "Creative Commons Attribution license (reuse allowed)" (read from the video's metadata with yt-dlp on 2026-09-19; the uploader
  is the man on screen). Cut: 7:06.62 to 7:17.03 of the 1080p source, cropped to 9:16 (`crop=608:1080:630:0,scale=720:1280`), kept at the
  source's 24 frames a second, the last frame held for 0.15 s so the clip ends on a breath, sound levelled to about -16 LUFS, mono AAC.
  He says: "If you're going to take anything away from this video, from my experience, then I want it to be this: when you press record,
  I want you to bring your genuine, authentic self." Chosen because the principal asked for the most appealing sample: a man talking to the
  camera with his real voice, no text or graphics burned into the picture, a plain area under his face where captions sit, and a line a
  creator would post. A quiet music bed sits about 14 dB under the voice in the source.
  The poster is frame 106 (4.4 s: eyes open, mouth closed), not frame 0, which is mid-laugh.
  Credit on both pages that show it: "Sample clip: Peter Kramm, CC BY" linking to the video. A courtesy note to the creator is a good idea
  before any paid promotion uses the clip.
- `dist/sample-words.json`: the tool's own word timings for that clip (`tools/transcribe.ts`, the same model the page uses), with one hand
  fix: the model dropped "it" in "I want it to be this"; the word was put back by splitting the model's "want" interval. `tools/mark-lines.ts`
  (run by `build.sh`) adds the tool's own line breaks.
- Rejected on review, 2026-09-19: AJ&Smart "Become A Better Workshop Facilitator" (CC BY). The source flashes title graphics every two
  seconds; cropped to 9:16 they read as broken letters under the captions. Earlier: a night photo of Earth with a generated voice (2026-09-17).
- To replace: put the three files in `dist/`, run `bun tools/mark-lines.ts` and read the lines it prints, change the credit links in
  `dist/index.html` and `dist/studio.html` and this file, check the studio card's framing (`.demo[data-demo="captions"]` in `studio.html`).
- `dist/studio-demo/`: copies of Vertical's sample made by `build.sh`; see `vertical/app/SOURCES.md`.
- `tests/fixtures/speech44.mp4`: test material only; not shipped.
