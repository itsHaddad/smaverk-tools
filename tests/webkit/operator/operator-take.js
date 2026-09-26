// operator-take.js: the Operator, driven from inside the page by the WebKit check (tests/webkit/check.mjs in the public
// mirror, branch webkit-check), after tests/webkit/camera-shim.js, which gives getUserMedia a camera playing a fixture
// video (and its sound). The same run works in Playwright WebKit, an iPhone profile and the iOS Simulator's Safari.
// It proves: the page and its models load (a face is found, so the face finder ran), a take records, Stop held for a
// second saves it, the MP4 is handed back for ffprobe, and it plays in the page's own player.
// Params: take (seconds to record, default 15), open (minutes the camera and the first face may take, default 8),
// sound=no (the camera without its sound: a sound track that gives nothing, as from an audio graph a browser holds until a
// tap, keeps some recorders from writing the picture).
(() => {
  const c = window.__check;
  const takeS = Number(c.params.take || 15), openMs = Number(c.params.open || 8) * 60_000;
  const now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const op = () => window.__op;
  const shimmed = () => !!window.__camera?.installed;
  if (c.params.sound === "no" && navigator.mediaDevices) { const g = navigator.mediaDevices.getUserMedia; Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, writable: true, value: (k = {}) => g.call(navigator.mediaDevices, { ...k, audio: false }) }); }
  const features = () => ({
    MediaRecorder: typeof MediaRecorder, mp4: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4"),
    VideoEncoder: typeof VideoEncoder, VideoFrameCopyTo: typeof VideoFrame !== "undefined" && typeof VideoFrame.prototype.copyTo,
    OffscreenCanvas: typeof OffscreenCanvas, WebGL2: !!document.createElement("canvas").getContext("webgl2"),
    storage: !!(navigator.storage && navigator.storage.getDirectory), wasmSimd: typeof WebAssembly === "object",
  });
  // The line above the picture and the state, logged when they change, so a hang says where it hung.
  let last = "";
  const watch = setInterval(() => { const o = op(); if (!o) return; const s = `${o.state} ${o.phase ?? ""} | ${o.line} | faces ${o.confirmed} looks ${o.look.count} (${o.look.where}) | rec ${o.recorder.pick}/${o.recorder.how ?? "-"} ${o.take ? o.take.seconds.toFixed(0) + " s" : ""} | ${document.getElementById("status")?.textContent ?? ""} | ${o.errors.slice(-1)[0] ?? ""}`; if (s !== last) { c.log(s); last = s; } }, 1000);
  // A press on the main button held for 1.3 s, as a person stops a take (the page judges the hold by the events' times).
  const holdStop = async (b) => {
    b.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await sleep(1300);
    b.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
  };
  const run = async () => {
    await c.waitFor(() => op() && document.getElementById("action"), 60_000, "the page's own script");
    c.log(`features ${JSON.stringify(features())}; camera shim ${shimmed() ? "in place" : "NOT in place"} (${typeof navigator.mediaDevices}, ${JSON.stringify(window.__camera ?? null)}); recorder ${op().recorder.pick}`);
    const b = document.getElementById("action"), t0 = now();
    b.click(); // Open the camera
    await c.waitFor(() => op().state === "live", openMs, "the camera opening");
    const cameraS = (now() - t0) / 1000;
    await c.waitFor(() => op().confirmed >= 1, openMs, "a face found (the face finder loaded and ran)");
    const faceS = (now() - t0) / 1000;
    c.log(`camera ${cameraS.toFixed(1)} s, first face ${faceS.toFixed(1)} s, looks at ${op().look.avgMs} ms (${op().look.where})`);
    b.click(); // Record
    await c.waitFor(() => op().state === "recording", 180_000, "recording");
    const rec0 = now();
    await sleep(takeS * 1000);
    const during = { fps: op().fps, shots: op().shots.filter((s) => s.t >= op().recStart).map((s) => s.kind), line: op().line };
    await holdStop(b);
    await c.waitFor(() => op().recorder.saved && op().state === "live", 5 * 60_000, "the take saved after Stop");
    const recS = (now() - rec0) / 1000, o = op();
    const v = document.getElementById("savedvideo");
    const blob = await (await fetch(v.src)).blob();
    await c.put(`take.${o.recorder.saved.ext}`, blob);
    // It plays: the end screen's own player, from the start, past 2 s.
    v.muted = true; v.currentTime = 0;
    await v.play().catch((e) => c.log(`play(): ${e.message}`));
    await c.waitFor(() => v.currentTime > 2, 30_000, "the saved video playing past 2 s");
    const played = +v.currentTime.toFixed(2); v.pause();
    clearInterval(watch);
    c.done({
      features: features(), cameraS: +cameraS.toFixed(1), firstFaceS: +faceS.toFixed(1), recordedS: +recS.toFixed(1),
      look: o.look, people: { finder: o.people.finder, where: o.people.where }, describer: o.memory.describer, during,
      recorder: o.recorder, stills: o.stills, played, videoSize: [v.videoWidth, v.videoHeight], camera: o.camera, pageErrors: o.errors,
    });
  };
  const go = () => run().catch((e) => { clearInterval(watch); c.fail(e, { at: op()?.state, line: op()?.line, look: op()?.look, errors: op()?.errors }); });
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", go); else go();
})();
