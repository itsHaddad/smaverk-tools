# Where the media on this page came from

## The sample on the page

`dist/sample.m4a` and `dist/sample.json` — **Artemis II: The Crew**, NASA's *Houston We Have a Podcast*,
episode 417, 27 March 2026. 64 minutes 38 seconds. Source:
https://www.nasa.gov/podcasts/houston-we-have-a-podcast/

NASA material is generally not copyrighted (17 U.S.C. §105, and NASA's own media usage guidelines), so it
can be used commercially. The page names NASA as the source next to the sample. Nobody speaking in it is
claimed to use or endorse anything, which is the one thing NASA's guidelines do ask.

The whole episode was read by this tool, on this machine, with the same three steps the page runs — the
same thirty-second windows, the same recogniser, the same silences, the same ranking (`tools/sample.ts`).
`sample.json` holds what came out, at each of the three clip lengths the page offers. `sample.m4a` is
twelve seconds cut from the opening of each moment, one after another, so a visitor can hear whether a
moment starts cleanly without downloading an hour of sound.

To rebuild it:

```
bun tools/sample.ts --mp3 <episode.mp3> \
  --title "Artemis II: The Crew, 65 min" \
  --credit "NASA, Houston We Have a Podcast, 27 March 2026 — public domain" \
  --url "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/"
```

## The gate fixture

`tests/fixtures/talk6.m4a` — a different episode, *Telling Time on Other Worlds*, 24 April 2026, also NASA
and also public domain. Its own note is in `tests/fixtures/SOURCES.md`.

It is deliberately not the episode on the page: a gate fixture is never also the material the tool was
looked at against (Quality.md, 2026-09-19).

## The typeface

`dist/fonts/bricolage-grotesque-latin.woff2` — Bricolage Grotesque, SIL Open Font License 1.1, the same
file the studio's other two tools carry.
