# Småverk tools

Two small web tools that do their work inside the browser tab.

This repository is the source of the live tools at **[captions.smaverk.com](https://captions.smaverk.com/)** and
**[vertical.smaverk.com](https://vertical.smaverk.com/)** — the same files, built the same way.

- **Captions** (`captions/app`) — puts spoken words onto a clip as captions you can drag and correct. Speech
  recognition runs in a Web Worker in the page (Whisper through transformers.js, WebGPU where the browser has it and
  WebAssembly where it does not). The clip is drawn frame by frame onto a canvas and written back to an mp4 with
  WebCodecs, with a MediaRecorder path for devices too slow for that.
- **Vertical** (`vertical/app`) — turns a landscape clip into a 9:16 one and keeps the speaker in frame. Faces are
  found on the device (MediaPipe in WebAssembly), the moving crop window is smoothed here, and the file is written
  with WebCodecs.

Both are free up to 60 seconds of clip. A key lifts that to five minutes — $19 for Captions, $24 for Vertical, paid
once. The checkout is Polar's; the small worker that turns a paid checkout into a key is not part of this repository.

## Checking the "on your device" claim yourself

The pages say your clip stays on your device. That is the kind of claim you should not have to take on trust, which is
most of why this code is readable. Three ways to check it, in rising order of effort:

1. **Watch the network.** Open DevTools → Network before you load the page, then pick a clip and run the tool. You will
   see the page, its font, the model files, the sample clip and a Cloudflare analytics ping. Your clip is not among
   them — there is no request carrying it, because there is nothing at the other end to carry it to.
2. **Take the network away.** Load the page, let the model finish downloading, then switch DevTools → Network to
   Offline (or pull the cable). Now pick a clip and run it. It still works. Software that uploads your video cannot do
   that.
3. **Read it.** `captions/app/app.ts` and `vertical/app/app.ts` are the whole of each tool. Every outside address the
   code names is declared at the top of those two files, and `tests/site.test.ts` fails the build if one appears that
   the privacy page does not account for.

## Running it

Needs [bun](https://bun.com) 1.3.2 and `ffmpeg`/`ffprobe` on PATH.

```bash
cd captions/app     # or vertical/app
bun install
bun run build       # bundles app.ts (+ worker.ts) into dist/, stamped with a version
bun run serve       # captions on http://localhost:8791, vertical on http://localhost:8801
```

`dist/` is tracked, because the page, its CSS and the sample clip are the source — the build only adds the bundled
JavaScript and stamps the version onto the asset URLs.

## Tests

```bash
cd captions/app && bun test          # unit tests: caption lines, windowing, encode maths, naming
bun tests/smoke.mjs                  # loads dist/ in headless Chromium: no page errors, sample present
bun test tests/site.test.ts          # from the repo root
```

That last one is the ripple check: it reads the built pages and the app sources and fails when the same fact is
stated two different ways — a price that drifted between the page and the script, a Privacy link pointing at the
wrong tool, a limit that one page states and another leaves out, a style rule the two tools no longer share.

The browser gates live in `.github/workflows/gates.yml` and need `bunx playwright install --with-deps chromium`:

- `tests/e2e/verify-speed.mjs` (Captions) runs a 44-second clip end to end and checks that captions appear before the
  clip finishes, that the fast save beats real time, and that the saved mp4 really has the words burned into it.
- `tests/e2e/verify-clip.mjs` (Vertical) does the same for tracking and cropping.
- `tests/e2e/verify-ui.mjs` (both) walks every state on an iPhone-sized viewport with awkward inputs — very long file
  names, names with no spaces, a clip that is already vertical — and audits each one: nothing wider than the screen,
  no text out of its box, no tap target under 44 px.

## What is not in here

Deployment, the unlock worker that turns a paid checkout into a key, and Småverk's own working notes stay in a
private repository. A few hand-run scripts that only work on the maintainer's machine are left out too, so a couple
of entries in `captions/app/package.json` (`deploy`, `test:e2e`, `test:file`) point at files you will not find.
Everything the two tools are made of is here, and everything the gates run is here.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Read it, run it, change it, pass it on — for any noncommercial purpose,
which includes personal use, study, and use by schools, charities and public bodies. Selling it, or running it as a
paid or ad-supported service, is not one of the permitted purposes.
