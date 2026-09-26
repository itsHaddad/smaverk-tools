// webkit-save-probe.js: the steps of the save (vertical/app/src/fastsave.ts), one at a time, each with its own time
// limit, so an engine where the save hangs says at which step. Same library, same settings, the fixture as input.
// Run by tests/webkit/check.mjs like any driver; the page itself is only the place it runs.
(() => {
  const c = window.__check;
  const t = () => performance.now();
  const limit = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
  const steps = [];
  const show = (r) => { if (r === undefined || r === null || typeof r === "function") return ""; if (typeof r !== "object") return JSON.stringify(r); try { const s = JSON.stringify(r); return s.length > 200 ? "" : s; } catch { return ""; } };
  const step = async (what, ms, fn) => {
    const t0 = t();
    try { const r = await limit(fn(), ms, what); steps.push({ what, ok: true, ms: Math.round(t() - t0) }); c.log(`ok   ${what} in ${Math.round(t() - t0)} ms ${show(r)}`); return r; }
    catch (e) { steps.push({ what, ok: false, ms: Math.round(t() - t0), error: String(e?.message ?? e) }); c.log(`FAIL ${what}: ${e?.message ?? e}`); throw e; }
  };
  (async () => {
    const mb = await step("load the library", 60_000, () => import("https://cdn.jsdelivr.net/npm/mediabunny@1.58.1/+esm"));
    const file = await step("fetch the fixture", 900_000, () => c.fixture(c.params.fixture || c.fixtures[0], "video/mp4"));
    const W = 608, H = 1080;
    const codec = await step("pick a video codec", 30_000, () => mb.getFirstEncodableVideoCodec(["avc", "hevc", "av1", "vp9"], { width: W, height: H }));
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
    const vt = await step("video track", 30_000, () => input.getPrimaryVideoTrack());
    await step("can decode", 30_000, () => vt.canDecode());
    const at = await step("audio track", 30_000, async () => { const a = await input.getPrimaryAudioTrack(); return a && { codec: a.codec, ch: a.numberOfChannels, rate: a.sampleRate, track: a }; });
    const out = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d", { alpha: false });
    const vsrc = new mb.CanvasSource(canvas, { codec, bitrate: 4e6, keyFrameInterval: 2, latencyMode: "quality", hardwareAcceleration: "no-preference" });
    out.addVideoTrack(vsrc, { frameRate: 30 });
    const copy = at && out.format.getSupportedCodecs().includes(at.codec);
    const acopy = copy ? new mb.EncodedAudioPacketSource(at.codec) : null;
    if (acopy) out.addAudioTrack(acopy);
    await step("start the output", 30_000, () => out.start());
    if (acopy) await step("copy 2 s of sound", 60_000, async () => {
      const sink = new mb.EncodedPacketSink(at.track); const meta = { decoderConfig: (await at.track.getDecoderConfig()) ?? undefined }; let n = 0;
      for await (const p of sink.packets()) { if (p.timestamp > 2) break; await acopy.add(p.clone({ timestamp: Math.max(0, p.timestamp) }), meta); n++; }
      return n;
    });
    // Each half alone, and the encoder with other settings, so a stall can be put on the decoder or the encoder.
    const soft = async (what, ms, fn) => { try { await step(what, ms, fn); } catch { /* recorded in steps; the next check still runs */ } };
    await soft("decode 2 s alone", 90_000, async () => { let n = 0; for await (const s of new mb.VideoSampleSink(vt).samples(0, 2)) { s.close(); n++; } return n; });
    for (const [name, opts] of [["default", {}], ["realtime", { latencyMode: "realtime" }], ["software", { hardwareAcceleration: "prefer-software" }]]) {
      await soft(`encode 60 drawn frames alone, ${name}`, 90_000, async () => {
        const o2 = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const g = cv.getContext("2d", { alpha: false });
        const src = new mb.CanvasSource(cv, { codec, bitrate: 4e6, keyFrameInterval: 2, latencyMode: "quality", hardwareAcceleration: "no-preference", ...opts });
        o2.addVideoTrack(src, { frameRate: 30 }); await o2.start();
        for (let n = 0; n < 60; n++) { g.fillStyle = `hsl(${n * 6} 60% 50%)`; g.fillRect(0, 0, W, H); await src.add(n / 30, 1 / 30); }
        await o2.finalize(); return o2.target.buffer.byteLength;
      });
    }
    const sink = new mb.VideoSampleSink(vt);
    const it = sink.samples(0, 2)[Symbol.asyncIterator]();
    const first = await step("decode the first frame", 60_000, () => it.next());
    await step("draw it", 30_000, async () => { first.value.draw(ctx, 0, 0, W, H); return first.value.timestamp; });
    await step("encode the first frame", 60_000, () => vsrc.add(0, 1 / 30));
    first.value.close();
    await step("decode, draw and encode 2 s", 180_000, async () => {
      let n = 1; for (;;) { const s = await it.next(); if (s.done) break; s.value.draw(ctx, 0, 0, W, H); await vsrc.add(n / 30, 1 / 30); s.value.close(); n++; } return n;
    });
    const bytes = await step("finalize", 60_000, async () => { await out.finalize(); return out.target.buffer.byteLength; });
    c.done({ codec, audio: at && { codec: at.codec, copied: !!acopy }, bytes, steps });
  })().catch((e) => c.fail(e, { steps }));
})();
