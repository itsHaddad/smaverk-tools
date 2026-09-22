# Clip finder — how the app is built

One page, no framework, no server for the recording. A podcast, a talk or an interview goes in; the
moments worth posting come out, with a time, a length, the words each one opens on, and a sentence saying
why. Everything the person's file touches runs in their browser.

## Pieces

| Piece | File | Job | Tested by |
|---|---|---|---|
| Page | `dist/index.html` | structure, copy, all CSS (light-dark tokens, phone-first, the studio's palette and type) | `tests/smoke.mjs`, `tests/e2e/verify-ui.mjs`, `Tools/Qa.ts` |
| UI wiring | `app.ts` | state machine (`sample → reading → found`), the picture on a 16:9 stage when the recording has one, the recording drawn as a band with the moments lit, the list, trim handles, playback, the exports, the licence | `tests/e2e/*` |
| Reading | `worker.ts` | the whole loop in a Web Worker: a window of sound → words → silences → ranked list, every three minutes of read sound | `tests/e2e/verify-find.mjs` |
| Windowed decode | `src/lib/decode.ts` | mediabunny reads the file in ranges and decodes a packet at a time; mix to mono, area-average resample to 16 kHz, fill one reused window buffer. Peak memory is one window, never the recording | the memory proof in `clipfinder/engine/tests/memory.test.ts` (its command-line twin) |
| Silences | `src/lib/silence.ts` | frame loudness against the window's own loud level; a quiet run over 0.6 s is a break. A few hundred numbers an hour | `tests/silence.test.ts` |
| Topic cuts | `src/lib/segment.ts` | TextTiling over word overlap: where the subject changes. No model, no weights, no download | `tests/lib.test.ts` |
| Candidates | `src/lib/candidates.ts` | runs of whole sections grown to the wanted length, each starting at a boundary, each boundary moved to the nearest silence | `tests/lib.test.ts` |
| Ranking | `src/lib/rank.ts` | three numbers, z-scored within the recording, equal weight; plus the sentences that say why | `tests/lib.test.ts` |
| Clean edges | `src/lib/edges.ts` | after the ranking has chosen, each moment's start moves to a whole sentence (a question first) and its end to a finished one, never into a neighbour | `tests/edges.test.ts`; bench R5 in `clipfinder/text/bench/edges-after.md` |
| Streaming | `src/lib/stream.ts` | which words a window may contribute, when to rank again, how long the clips should be for this recording | `tests/lib.test.ts` |
| Exports | `src/lib/exports.ts` | EDL (CMX3600), Final Cut 7 XML (Premiere and Resolve), FCPXML, and a marker list | `tests/exports.test.ts`, `tests/e2e/verify-find.mjs` |
| The cut clip | `app.ts` (`saveClip`) | mediabunny copies the chosen range out of the file, without re-encoding where it can | `tests/e2e/verify-find.mjs` (ffprobe on the saved file) |
| Money | `src/lib/pricing.ts` | every sentence the page says about money, paid and trial side by side so neither rots; the key itself is `src/lib/unlock.ts`, the same file in all three tools | `tests/lib.test.ts`, `tests/e2e/verify-find.mjs` (the sandbox rail) |
| Canvas colours | `src/lib/theme.ts` | resolves `light-dark(a,b)`, which a canvas silently drops and which made the map paint black on black | `tests/page.test.ts` |
| Empty answers | `src/lib/advice.ts` | what to say when a recording holds nothing at this length — never a length that is not on the page | `tests/page.test.ts` |
| Names | `src/lib/naming.ts` | clocks, spoken lengths, a long file name shortened in the middle, output file names | `tests/lib.test.ts` |
| Sample | `dist/sample.json`, `dist/sample.mp4`, `dist/poster.jpg` | a real 15-minute video interview read by this tool, at all three clip lengths, with fifteen seconds from the opening of each moment | `tests/smoke.mjs`, `tests/site.test.ts` |
| Sample builder | `tools/sample.ts` | runs the page's own three steps on the command line, so the sample is this tool's output and can be rebuilt | — |
| Fixture | `tests/fixtures/talk6.mp3` | 6 min 30 s of a different public-domain recording, as an mp3 because that is what podcasts are | — |

## Invariants

- Nothing carrying the recording leaves the device. The only network traffic is the one-off download of
  the tool, the analytics ping, the Polar checkout (their page) and the key check (the key only).
  `tests/e2e/verify-find.mjs` records every request the page makes and fails on two things: a host that
  the privacy page does not account for, and any body over 8 KB — the fixture is a 2.3 MB recording, so
  nothing worth taking out of it fits under that bar.
- With the tool already on the device, the whole thing works with the network off. That is in the gate.
- $50 once (the owner, 2026-09-22; free while new from 2026-09-21). Free reads 30 minutes and shows every
  moment; paid reads four hours and opens every export. `PRICE` in `app.ts` is the one number and
  `tests/site.test.ts` fails if a page states another or the script holds a second one. `TRIAL` turns the
  free-while-new state back on; its copy stays tested in `src/lib/pricing.ts`.
- The ranking never becomes a prediction. No score is shown, and the page may not say "viral",
  "engagement" or "will perform" — `tests/site.test.ts` fails the build if it does.
- Every public string obeys `MarketingRules.md`; errors name the step and say what to do next.
- Scripts are versioned per deploy (`app.js?v=`, `worker.js?v=`). Without the stamp, phones run stale code.
- Production branch is `main`. `deploy.sh` is the only path.

## How to write a test after a bug

Two rules, both learned the expensive way on this branch.

**Assert the behaviour, never the syntax that produces it.** A 2026-09-19 bug had the page saying one thing
about the free limit while the script, after a key was removed, wrote another. The test written for it asserted
that `app.ts` contained the sentence *as a ternary* — `: "<the page's sentence>";`. That pinned an
implementation, not a promise: when the free limit moved to `#pricefine` and the sentence became a constant, a
correct simplification failed a green test, and the test taught nobody anything in the meantime. What the bug
was about is that the page and the script agree, so that is what is checked now, plus the thing that actually
went wrong — that the line does not restate a limit another line already owns.

**Check the relationship, not the parts.** `Qa.ts` reports every control's own size and a 44 px minimum, and it
reported zero blockers while two links on consecutive lines each claimed a 44 px tap box, overlapped by
123 x 22 px, and the later one won the hit test — so on a phone, aiming at the link that recovered a paid key
destroyed it instead. No per-control check can see that, because every control was individually fine. The guard
that catches it (`tests/e2e/verify-ui.mjs`, in all three tools) measures pairs of hit rectangles, in every state
the matrix visits plus a forced paid state, and writes `out/ui/unlock-overlaps.json` so a failure says what it
saw. On its first real run it found the same defect in the shared footer and in the stacked link lists — live,
on tools people had already paid for, past three cold-user rounds and five design reviews.

**And audit the states a customer can be in, not the state the page loads in.** The paid panel is `hidden` at
rest, so every at-rest audit had skipped it entirely: the panel holding the key, the Copy button and the
destructive control had shipped without one tap-target pass at any width in any theme.

## Tools that look local and are not

`Mission.ts` resolves its missions from `ROOT = process.env.MISSIONS_DIR ?? ~/projects/missions`, **not** from the
working directory. So `Mission.ts log <slug> risk "…"` run inside a git worktree appends to the ledger in the
shared tree, silently, while the worktree's own copy of that ledger is untouched. It prints "logged" either way.

Two consequences, both of which happened on 2026-09-21: the entries sit uncommitted in a tree several agents
share, where somebody else's `git add -A` can sweep them into an unrelated commit; and the branch carries its own
copy of the same file, so the ledgers conflict at merge. **Take both sides' entries** — a ledger is append-only
and no line in it is a replacement for another.

It is the same shape as the other traps written down here: an action that looks local and is not, which reports
success in both cases. Set `MISSIONS_DIR` when the mission's records should follow the branch, or run it from the
shared tree deliberately. Whether the tool should take a directory or refuse to run outside one is not decided.

## A known defect in the deploy gate

`deploy.sh` refuses to deploy unless the design review and the cold-user round are **newer than
`dist/index.html`**. That file is rewritten by `build.sh` on every single build, to re-stamp the cache-busting
`?v=` numbers. So a review expires by modification time without one reviewed word changing — and it did, on
2026-09-21: the pages differed from the reviewed content by exactly five `?v=` numbers and the gate would still
have refused.

The workaround in use is honest but manual: each review records the commit it stands for, and that claim is
checked (`git diff` the page since the review) before the file is re-saved. Anyone in a hurry will instead
`touch` the file, which gets past the gate and tells nobody anything — a gate that can be satisfied without
doing the thing it guards is worse than no gate.

**The fix it needs:** compare a review against the content it reviewed, not against an artifact that is rebuilt
every time. Either hash the page with the `?v=` stamps stripped and record that hash in the review, or compare
against the source the page is built from. Not done yet; do not let it rot.

## What decides the list, and what it cost to find out

Three numbers, each measured on its own against 169 clips that the people who made those recordings
published themselves, leaving each show out of the fitting in turn: **+7.0 / +5.9 / +10.4 points over
picking at random** on clean text, and about half of that at the error rate of the recogniser in the page.
Moving each boundary to the nearest silence is worth **+1.6**, and making the moments keep clear air
between them is worth **+6.4** on top of the three (+8.0 to +14.4 against darts, luck 7.2% to 0.1%,
positive in all three shows): a candidate starts at every topic boundary, so the top N were neighbours and
the list was one passage handed back four times.

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

## What a visitor downloads

Measured in the browser on the green gate run, not estimated:

| | |
|---|---|
| The page before anyone touches it | **796 KB** — html, app.js, the font, and the 65-minute sample's list and sound |
| The tool, on first intent only | **35 MB** (Moonshine base, q8), plus the runtime it fetches from a public file host |

Nothing of the 35 MB is fetched until the person opens the picker or touches the band; the smoke gate fails
if anything heavy moves before that. For contrast, the one open-source rival with a working pipeline needs
a 1.4 GB model. That contrast is only ours while the number stays small, so it is written here and the
gate reports it on every run.

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

- Reading, measured: **0.127× real time** in the browser on a two-core cloud runner (390 s of sound read
  in 50 s, 987 words), and 0.40× on a 2017 laptop through Node at one thread. A phone has not been
  measured and will be slower. Moments appear once there is enough read to hold a clip of the chosen
  length, and then every three minutes of read sound.
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

- The clip length is a floor, not a promise. The generator adds whole sections until it reaches the
  target, so every moment exceeds it (median 1.54x). Capping it was measured at **-1.8** points, because
  shortening candidates takes the signal out of `length`, the feature carrying the ranker. The page
  describes the control instead of promising a length.
- **A moment can open mid-sentence.** Starting on a sentence was measured at **-2.6** and did not ship; the
  page says so where the export buttons are, and the trim handles are what a person reaches for. A
  length-preserving variant (move the start forward AND the end by as much) is the next thing to measure.
- The tool itself is fetched from public file hosts on first use — 28 requests that are not this page.
  The recording does not leave, which is what the page claims. Self-hosting those files would let the
  headline go back to an absolute; until then it does not claim one.
