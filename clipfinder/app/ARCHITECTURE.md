# Clip finder — how the app is built

One page, no framework, no server for the recording. A podcast, a talk or an interview goes in; the
moments worth posting come out, with a time, a length, the words each one opens on, and a sentence saying
why. Everything the person's file touches runs in their browser.

## Pieces

| Piece | File | Job | Tested by |
|---|---|---|---|
| Page | `dist/index.html` | structure, copy, all CSS (light-dark tokens, phone-first, the studio's palette and type) | `tests/smoke.mjs`, `tests/e2e/verify-ui.mjs`, `Tools/Qa.ts` |
| UI wiring | `app.ts` | state machine (`sample → reading → found`), the recording drawn as a band with the moments lit, the list, trim handles, playback, the exports, the licence | `tests/e2e/*` |
| Reading | `worker.ts` | the whole loop in a Web Worker: a window of sound → words → silences → ranked list, every three minutes of read sound | `tests/e2e/verify-find.mjs` |
| Windowed decode | `src/lib/decode.ts` | mediabunny reads the file in ranges and decodes a packet at a time; mix to mono, area-average resample to 16 kHz, fill one reused window buffer. Peak memory is one window, never the recording | the memory proof in `clipfinder/engine/tests/memory.test.ts` (its command-line twin) |
| Silences | `src/lib/silence.ts` | frame loudness against the window's own loud level; a quiet run over 0.6 s is a break. A few hundred numbers an hour | `tests/silence.test.ts` |
| Topic cuts | `src/lib/segment.ts` | TextTiling over word overlap: where the subject changes. No model, no weights, no download | `tests/lib.test.ts` |
| Candidates | `src/lib/candidates.ts` | runs of whole sections grown to the wanted length, each starting at a boundary, each boundary moved to the nearest silence | `tests/lib.test.ts` |
| Ranking | `src/lib/rank.ts` | three numbers, z-scored within the recording, equal weight; plus the sentences that say why | `tests/lib.test.ts` |
| Streaming | `src/lib/stream.ts` | which words a window may contribute, when to rank again, how long the clips should be for this recording | `tests/lib.test.ts` |
| Exports | `src/lib/exports.ts` | EDL (CMX3600), Final Cut 7 XML (Premiere and Resolve), FCPXML, and a marker list | `tests/exports.test.ts`, `tests/e2e/verify-find.mjs` |
| The cut clip | `app.ts` (`saveClip`) | mediabunny copies the chosen range out of the file, without re-encoding where it can | `tests/e2e/verify-find.mjs` (ffprobe on the saved file) |
| Names | `src/lib/naming.ts` | clocks, spoken lengths, a long file name shortened in the middle, output file names | `tests/lib.test.ts` |
| Sample | `dist/sample.json`, `dist/sample.m4a` | a real 65-minute recording read by this tool, at all three clip lengths, with twelve seconds from the opening of each moment | `tests/smoke.mjs`, `tests/site.test.ts` |
| Sample builder | `tools/sample.ts` | runs the page's own three steps on the command line, so the sample is this tool's output and can be rebuilt | — |
| Fixture | `tests/fixtures/talk6.mp3` | 6 min 30 s of a different public-domain recording, as an mp3 because that is what podcasts are | — |

## Invariants

- Nothing carrying the recording leaves the device. The only network traffic is the one-off download of
  the tool, the analytics ping, the Polar checkout (their page) and the key check (the key only).
  `tests/e2e/verify-find.mjs` records every request the page makes and fails on two things: a host that
  the privacy page does not account for, and any body over 8 KB — the fixture is a 2.3 MB recording, so
  nothing worth taking out of it fits under that bar.
- With the tool already on the device, the whole thing works with the network off. That is in the gate.
- Free: 30 minutes. Paid: four hours, and every export. `FREE_S` and `PAID_S` in `app.ts` are the only
  source; the page, the script and `llms.txt` are checked against them by `tests/site.test.ts`.
- The ranking never becomes a prediction. No score is shown, and the page may not say "viral",
  "engagement" or "will perform" — `tests/site.test.ts` fails the build if it does.
- Every public string obeys `MarketingRules.md`; errors name the step and say what to do next.
- Scripts are versioned per deploy (`app.js?v=`, `worker.js?v=`). Without the stamp, phones run stale code.
- Production branch is `main`. `deploy.sh` is the only path.

## What decides the list, and what it cost to find out

Three numbers, each measured on its own against 169 clips that the people who made those recordings
published themselves, leaving each show out of the fitting in turn: **+7.0 / +5.9 / +10.4 points over
picking at random** on clean text, and about half of that at the error rate of the recogniser in the page.
Moving each boundary to the nearest silence is worth **+1.6**.

Ten other candidates were measured and dropped. Laughter and applause are the loudest lesson: the first
version of this tool ranked by sound alone and scored **9.3% against random's 31.9%** — a talk opens and
closes with applause and nobody publishes either. That whole exercise is in `clipfinder/groundtruth/`,
`clipfinder/killtest/` and `clipfinder/text/`, which stay in the private repository.

## The recogniser, and why it is that one

Measured on ten minutes of a real talk, both fed the same thirty-second windows the page feeds them:

| | Moonshine base | Whisper tiny |
|---|---|---|
| Disagreement with the recording's own caption track | **8.4%** | 35.2% |
| Downloaded | 64 MB | 42 MB |
| Speed, one thread on a 2017 laptop | **0.40× real time** | 0.48× |
| Word times | none; placed across the window | from the model |

The gap is not a rounding difference and it is visible in the text: Whisper, handed thirty seconds with no
context on either side, falls into repeating itself and loses whole passages. Both are MIT for English.

Moonshine reports no word times, so a window's words are spread across it by their length — 0.69 s from
where the caption track puts them at the middle, 1.68 s at the ninetieth. A topic boundary is only
resolved to about seven seconds anyway, and the boundary is then moved to a silence measured from the
sound itself, which is a better answer than the word gaps the research tree used.

## Commands

```
bun test                 # unit tests (src/lib)
bun run smoke            # headless load of dist/: no page errors, the sample, versioned scripts, words at rest
bun run test:find        # the product gate: a real recording through dist/, exports, the offline run
bun run test:ui          # the phone UI gate: every state on an iPhone viewport
bun run serve            # dist/ on http://localhost:8811
bun run deploy           # ./deploy.sh
bun tools/sample.ts      # rebuild the sample on the page
```

## Known limits

- Reading costs about half the length of the recording on a 2017 laptop at one thread. A phone has not
  been measured. Moments appear from about four minutes of read sound and then every three minutes.
- English. The Moonshine models for other languages are not licensed for commercial use.
- A recording under about four minutes has nothing to cut up and the page says so.
- The timeline files are read back correctly by **OpenTimelineIO 0.18.1**, the Academy Software
  Foundation's reference implementation of these formats: all three parse and every moment comes back at
  the time it was written (`clipfinder/assets/verification/timeline-formats.md`). That exercise found two
  real faults, both fixed — an edit list carries no frame rate, and a comment above the first event made
  the whole file unreadable. But **no one has opened one in Premiere, Resolve or Final Cut yet**, and
  those three have their own readers. Until somebody has, that is the one claim on the page without a
  measurement under it.
- The clip cut copies the chosen range without re-encoding where the codec allows and re-encodes where
  it does not. The gate exercises it on an mp3, which is the re-encoding case. A video recording has not
  been through it yet.
