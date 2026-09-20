# Captions — how the app is built

One page, no framework, no server for the video. Everything the person's clip touches runs in their browser.

## Pieces

| Piece | File | Job | Tested by |
|---|---|---|---|
| Page | `dist/index.html` | structure, copy, all CSS (light-dark tokens, phone-first, sticky action, no zoom-on-focus) | `tests/smoke.mjs`, `Tools/Qa.ts` |
| UI wiring | `app.ts` | state machine (`sample → loaded → working → captioned → exporting → exported`), stage + canvas painting, drag, fix-word mode, captions shown as each window is heard, save (fast path, then recorder), license unlock, founding counter | `tests/e2e/*` |
| Speech engine | `worker.ts` | Whisper (transformers.js) in a Web Worker: download with progress, setup phase, WebGPU with WASM fallback, retry on a fresh WASM engine if the GPU path fails mid-run; hears the clip in 30 s windows and posts each window's words (`partial`) before the whole (`result`) | `tests/e2e/verify-speed.mjs`, Kaggle probes in `tools/kaggle/` |
| Windows | `src/lib/windows.ts` | fewest 30 s windows that cover the clip (60 s → 2, 300 s → 10), spread evenly; each keeps the words up to the middle of its overlap with the next | `tests/windows.test.ts` |
| Caption lines | `src/lib/lines.ts` | words → fixed lines (≤5 words, ≤2.6 s, cut at pauses and sentence ends); which line and word is on screen at time t | `tests/lib.test.ts` |
| Fast save | `src/fastsave.ts` | WebCodecs through Mediabunny: decode frames → draw frame + captions on a canvas → H.264 encoder → mp4; sound copied packet for packet (AAC/Opus) or re-encoded; gives up (`TooSlow`) when the device runs under real time so the recorder takes over | `tests/e2e/verify-speed.mjs`, `tests/e2e/bench-save.mjs` |
| Encode numbers | `src/lib/encode.ts` | bitrate from size and frame rate (≈0.1 bit/pixel/frame, 1.5–10 Mbit/s), frame-rate snapping | `tests/encode.test.ts` |
| Naming | `src/lib/naming.ts` | output file name from the clip name; dated fallback for junk names | `tests/lib.test.ts` |
| Audio maths | `src/lib/audio.ts` | mono mix, trim, 16 kHz resample; listening-time estimate | `tests/lib.test.ts` |
| Audio reading | `app.ts` (`decodeAudio`) | WebCodecs via Mediabunny first (iPhone .mov), then `decodeAudioData` (callback form), then audio-only remux | `tests/e2e/verify-file.mjs` with `.mov` files |
| Unlock worker | `../worker/src/index.ts` | `/key?checkout_id=` → buyer's key after a Polar checkout; `/count` → paid orders for the founding offer. Org tokens are Worker secrets | sandbox purchase in `Workflows/Payments.md` |
| Studio page | `dist/studio.html`, `functions/_middleware.js`, `dist/_routes.json` | smaverk.com is served from this same project: the Pages Function rewrites `/` to `/studio` (clean URL) and `/sitemap.xml` to the studio sitemap for the studio host only; every other path is static | `tests/smoke.mjs` (loads /studio.html), `Tools/Qa.ts` on https://smaverk.com/ in deploy.sh |
| Sample | `dist/sample.mp4`, `sample-words.json`, `poster.webp` | the result shown at rest; built with `tools/voice.mjs` + ffmpeg + `tools/transcribe.ts` | — |
| Fixture | `tests/fixtures/speech44.mp4` | 44 s of public-domain speech on a flat background, for the speed gate | — |
| Phone UI gate | `tests/e2e/verify-ui.mjs` + `Missions/Tools/uiaudit.mjs` | every state (rest, loaded, working, captioned, fix-words, saved) with awkward inputs (long name, no-space name, landscape) on an iPhone viewport: nothing wider than the screen, no text spilling, one column width, scale and font unchanged; screenshots in `tests/e2e/out/ui/` | itself, on every deploy |

## Invariants

- Nothing carrying the clip leaves the device. The only network traffic is the engine download, the analytics ping, the Polar checkout (their page) and the unlock worker (checkout id only).
- Free: 60 s. Paid: 300 s. `limit()` in `app.ts` is the single source.
- Every public string obeys `MarketingRules.md`; errors name the step and carry a mail link with details.
- Scripts are versioned per deploy (`app.js?v=`, `worker.js?v=`). Cloudflare's edge caches `app.js` for 4 h and ignores our `Cache-Control`; without the stamp phones run stale code.
- Production branch is `main`. `deploy.sh` is the only path: unit tests → build → stamp → smoke in a real browser → speed gate (a real clip: captions before the end, fast save faster than real time, valid mp4 with captions in it) → deploy → audit. `QUICK=1` skips the speed gate for copy-only changes.
- The engine warms itself: on first intent (picker opened, a style or the stage touched) and, on connections that are not data-saver or 2G/3G, three seconds after the page is up. Concurrent loads join one download.

## Commands

```
bun test                 # unit tests (src/lib)
bun run smoke            # headless load of dist/: no page errors, sample present, versioned scripts
bun run test:speed       # headless: 44 s clip through dist/ — partial captions, fast save, ffprobe + burned-in check
bun tests/e2e/bench-save.mjs   # where the save spends its time, per stage, under a few encoder settings
bun run test:e2e         # headed Chromium: load a clip, caption, save, liveness meter (needs WSLg display)
bun run test:file        # a real file through the input in headless Chromium
bun run qa               # Missions Qa.ts audit of the live page (three contexts)
bun run deploy           # ./deploy.sh
```

## Known limits

- Save speed depends on how the browser hands decoded frames to a canvas. Measured 2026-09-18: headless Chromium (software) ≈ 1.9× real time at 540×960; the principal's Brave on the laptop ≈ 2× at 720×1280 (11–14 ms a frame to draw, decode and encode cheap; software decoding changes nothing). Phones with hardware codecs and a GPU canvas should do better; not yet measured on one. Under 1× the page falls back to the recorder.
- Whisper hears 30 s at a time, so a 60 s clip is two passes and the first captions appear after the first pass (about half the old wait); a 10 s clip is unchanged.
- WebGPU has only been exercised on SwiftShader (Kaggle) and is unavailable in the principal's Brave; a real-GPU run happens on the iPhone.
- The Mediabunny chunk is 720 KB and loads only when a clip is read or saved.
