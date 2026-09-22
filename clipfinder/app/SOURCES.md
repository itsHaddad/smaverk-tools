# Where the media on this page came from

## The sample on the page

`dist/sample.mp4`, `dist/poster.jpg` and `dist/sample.json` — **Astronaut Matt Dominick talks with KMGH
Denver**, 10 May 2024: a TV reporter in Denver interviews a NASA astronaut aboard the International Space
Station. 15 minutes 27 seconds, video. Source: https://images.nasa.gov/details/iss071m261311538_NASA_Astronaut_Matt_Dominick_Talks_with_KMGH_Denver_240510

NASA material is generally not copyrighted (17 U.S.C. §105, and NASA's own media usage guidelines), so it
can be used commercially. The page names NASA as the source next to the sample. Nobody in it is claimed to
use or endorse anything, which is the one thing NASA's guidelines do ask.

Chosen 2026-09-22 because the page should show what the tool does to a video, the job most people bring it:
a real conversation, questions and answers, with a picture worth looking at. It replaced a 65-minute NASA
podcast episode that was sound only.

The whole recording was read by this tool, with the same steps the page runs — the same thirty-second
windows, the same recogniser, the same silences, the same ranking and the same clean edges
(`tools/sample.ts`). `sample.json` holds what came out, at each of the three clip lengths the page offers.
`sample.mp4` is fifteen seconds from the opening of each moment, one after another, 640 wide, so a visitor
can see and hear whether a moment starts cleanly without downloading the whole interview. `poster.jpg` is
a frame from the strongest one-minute moment.

The file read, NASA's own mobile rendition:
https://images-assets.nasa.gov/video/iss071m261311538_NASA_Astronaut_Matt_Dominick_Talks_with_KMGH_Denver_240510/iss071m261311538_NASA_Astronaut_Matt_Dominick_Talks_with_KMGH_Denver_240510~mobile.mp4

**Rebuild it whenever the ranker changes**, or the page shows output its own tool would no longer return.
It runs on a runner, not the laptop (about two minutes for this one) — dispatch `clipfinder-sample` in the
public repo, which defaults to this recording, and commit the files it uploads:

```
gh workflow run clipfinder-sample.yml -R itsHaddad/smaverk-tools
```

## The gate fixture

`tests/fixtures/talk6.m4a` — a different episode, *Telling Time on Other Worlds*, 24 April 2026, also NASA
and also public domain. Its own note is in `tests/fixtures/SOURCES.md`.

It is deliberately not the episode on the page: a gate fixture is never also the material the tool was
looked at against (Quality.md, 2026-09-19).

## The typeface

`dist/fonts/bricolage-grotesque-latin.woff2` — Bricolage Grotesque, SIL Open Font License 1.1, the same
file the studio's other two tools carry.
