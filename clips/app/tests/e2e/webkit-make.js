// webkit-make.js: Clips, driven from inside the page, so the same run works in Playwright WebKit, an iPhone profile
// and the iOS Simulator's own Safari (tests/webkit/check.mjs injects it before the page's scripts).
//
// It picks the fixture recording the way a person does (the file input's change event), waits for the moments, keeps
// the first `clips` of them (default 2: the first clip carries the engines' start-up, the second shows the steady
// pace), makes them, and hands each finished file back to the server for ffprobe. The report carries what the page
// measured itself: time to read, time per clip against the clip's own length, and the per-step split.
(() => {
  const c = window.__check;
  const want = Number(c.params.clips || 2);
  const now = () => performance.now();
  const features = () => ({
    VideoDecoder: typeof VideoDecoder, VideoEncoder: typeof VideoEncoder, AudioDecoder: typeof AudioDecoder, AudioEncoder: typeof AudioEncoder,
    OffscreenCanvas: typeof OffscreenCanvas, WebGL2: !!document.createElement("canvas").getContext("webgl2"), gpu: !!navigator.gpu,
    SharedArrayBuffer: typeof SharedArrayBuffer, wasmThreads: typeof SharedArrayBuffer !== "undefined" && !!self.crossOriginIsolated,
    deviceMemory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency ?? null,
  });
  const run = async () => {
    await c.waitFor(() => window.clips && window.__clips && document.getElementById("file"), 60_000, "the page's own script");
    const f = features();
    c.log(`features ${JSON.stringify(f)}`);
    const name = c.params.fixture || c.fixtures[0];
    const file = await c.fixture(name, "video/mp4");
    c.log(`fixture ${name}: ${(file.size / 1e6).toFixed(1)} MB`);

    const input = document.getElementById("file");
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    const t0 = now();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    let last = "";
    const tick = setInterval(() => { const s = `${window.__clips.state} heard=${Math.round(window.__clips.heardS || 0)}s made=${(window.__clips.made || []).length} ${document.getElementById("s3n")?.textContent || ""}`; if (s !== last) c.log(s); last = s; }, 15_000);
    try {
      await c.waitFor(() => window.__clips.state === "found" || window.__clips.error, 40 * 60_000, "finding the moments");
      if (window.__clips.error) throw new Error(`finding failed: ${window.__clips.error}`);
      const findS = (now() - t0) / 1000;
      const list = window.__clips.list;
      if (!list.length) throw new Error("no moments found");
      const keep = Math.min(want, list.length);
      for (let i = 0; i < list.length; i++) window.clips.keep(i, i < keep);
      c.log(`${list.length} moments in ${findS.toFixed(1)} s; making ${keep}`);

      const t1 = now();
      await window.clips.make();
      const makeS = (now() - t1) / 1000;
      const made = window.__clips.made || [];
      if (window.__clips.error) c.log(`a clip failed: ${window.__clips.error}`);
      for (const m of made) {
        const blob = await (await fetch(window.clips.url(m.i))).blob();
        await c.put(m.name, blob);
      }
      const clips = made.map((m) => {
        const lengthS = m.endS - m.startS, workS = Object.values(m.ms).reduce((a, b) => a + b, 0) / 1000;
        return { name: m.name, lengthS: +lengthS.toFixed(2), workS: +workS.toFixed(1), perSecondOfClip: +(workS / lengthS).toFixed(2), width: m.width, height: m.height, audio: m.audio, words: m.words, captionFrames: m.captionFrames, frames: m.frames, ms: m.ms };
      });
      const result = { features: f, sourceHeight: window.__clips.sourceHeight ?? null, recordingS: window.__clips.totalS, findS: +findS.toFixed(1), moments: list.length, makeS: +makeS.toFixed(1), clips, pageError: window.__clips.error ?? null };
      if (made.length !== keep) return c.fail(`${made.length} of ${keep} clips made: ${window.__clips.error || document.getElementById("status").textContent || "no error given"}`, result);
      c.done(result);
    } finally { clearInterval(tick); }
  };
  run().catch((e) => c.fail(e));
})();
