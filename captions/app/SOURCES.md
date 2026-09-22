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
- `dist/studio-demo/`: copies of Vertical's sample made by `build.sh`; see `vertical/app/SOURCES.md`. Clip finder has no sample of
  its own to copy, so its two files are kept in `assets-src/studio-demo/` and copied in by the same script.
- `assets-src/studio-demo/clipfinder-sample.mp4` and `clipfinder-poster.webp`: a screen recording of the live tool
  (clipfinder.smaverk.com) doing one real run on 2026-09-22, made on a GitHub runner in Chromium at a 640 x 360 viewport
  (small on purpose: the tool's own text has to survive being shown in a 395 x 222 card).
  Nothing in the frame is drawn, staged or re-created: what a viewer sees is what the tool did.
  What was fed to it: ten minutes cut from 6:00 of **Artemis II: The Crew**, NASA's *Houston We Have a Podcast*, episode 417,
  27 March 2026 — https://www.nasa.gov/podcasts/houston-we-have-a-podcast/ . NASA material is generally not copyrighted
  (17 U.S.C. §105 and NASA's media usage guidelines); it is the same episode the tool's own page uses as its sample. The
  studio page credits it in the footer ("Clip finder sample: NASA, public domain").
  What it did, on the "1 min" setting: put two moments on screen while it was still reading (at 42% through, with the
  progress bar and the first moment card in the same frame), re-scored the list as it went — an early 0:15 moment drops
  out again and 2:20 falls from 1 min 30 s to 59 s, which is the tool correcting itself and it stays in — and finished
  with three: 4:22 / 1 min 10 s, 2:20 / 59 s and 6:36 / 55 s, the last reading "Sets something up and comes back to it".
  The first moment is then played.
  **The cut starts where the first moment lands, so the card opens on the tool already finding something and the page's
  own marketing is never in frame. The reading is condensed 10x; the last 4.6 seconds — the settled list and a moment
  played — run at their own speed. 9.08 seconds in all, one take, one cut, nothing added to the frame. The cut starts 1.5 s later than the first version of it, so the opening frame already has a found moment in it and the poster matches it: entry and every loop restart no longer jump backwards past the moment to a bar at 38% with the tool's price block in shot (design review, round 5).**
  **What the card says about speed, and what backs it.** The tool's own on-screen line read 1:31, 1:21, 1:18, 1:30, 1:15
  and 1:15 across six runs of the same ten-minute file — all on a **GitHub Actions standard runner, two cores**, which is
  the machine the card names and a floor rather than a median: a recent laptop has more to work with, not less. Sixteen
  seconds of spread around a minute and a half is tight enough to state, so the card states it as a **ratio** — "It read
  ten minutes in about a minute and a half on a plain two-core machine — roughly a tenth of a recording's length" — which every one
  of the six runs supports and which survives the hardware changing under it, where a bare number would not.
  The card said nothing about speed for a while. The cold user argued that out on 2026-09-22 and was right: what a viewer
  is left to guess from a sped-up picture is wrong by an order of magnitude **in the direction that flatters us**, and a
  number withheld because it is inconveniently variable is not the same as one withheld because it would mislead.
  The line "One real run, sped up to fit." stays with it: the cold user read it as a claim about the evidence rather than
  about the medium, and said it is why they believed the picture. `tests/site.test.ts` fails the build if either half goes
  missing, if the ratio or the machine changes without this file changing with it, or if the card starts promising a
  speed no run can be held to.
  Not yet measured, and therefore not claimed: a real phone, a real laptop, and a recording of the length this tool
  actually sells to (an hour, not ten minutes). Those numbers are the clip finder's highest-value open item.
  The poster is the first frame of the cut: "Listening to your recording, 42%" with the bar half full and the first moment already
  found underneath it, with its time, its length and its reason.
  **Why the ending is framed as it is.** The settled state is the result header, a line of shared reasoning that wraps to
  two lines, then the three moments; the played card grows to 136 px when its trim handles open. Header to the bottom of
  the second card measures 325 px, and to the bottom of the third about 430 px. So a 16:9 frame holding the header and
  all three moments has to be about 764 px wide, at which the tool's text is 0.52 of card size — the size the design
  review blocked on in round 2. At 640 x 360 the header and the first two moments are whole and the third is below the
  edge. That is a measured limit of the tool's own layout, not a framing choice: shortening the shared-reason line, or
  not opening the trim handles until the card is touched, is what would make the strict framing fit, and both are product
  changes rather than recording ones.
  **Known gap, left deliberately (cold user, round 4).** The only number inside the picture is `10:00`, on the finished
  "Listening to your recording" row, and a viewer reads it as "it listened to a ten-minute recording" — which quietly
  shrinks a card whose pitch is long podcasts and interviews. Feeding the whole 1:04:38 episode instead of the ten-minute
  excerpt would put `1:04:38` in that row and carry the input beat the picture cannot otherwise show. It is a re-run, not
  a re-design: the same script at the same 640 x 360 framing, but the reading takes about eight minutes on a runner, so
  the condense goes from 10x to roughly 100x, and both review rounds have to be re-signed against the new file. Left
  because a demo on the card today is worth more than a better demo later; do it the next time this is touched.
  To replace it: record the live page again (a runner, never the laptop), keep it under twenty seconds and no heavier than
  the other two cards' videos, put both files here, and rewrite the paragraphs above with what that run actually did.
- `tests/fixtures/speech44.mp4`: test material only; not shipped.
