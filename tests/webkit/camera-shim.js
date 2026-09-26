// camera-shim.js: a camera that plays a fixture video, for pages that call getUserMedia. Pass it as the first
// --driver to check.mjs, before the page's own driver, and name the video with --param camera=<fixture basename>:
//
//   node tests/webkit/check.mjs --serve <dist> --driver tests/webkit/camera-shim.js --driver <your driver> \
//        --fixture room.mp4 --param camera=room.mp4 --engine webkit --device "iPhone 15"
//
// The page gets a MediaStream whose picture is the video drawn onto a canvas at 30 fps (Safari has no
// HTMLVideoElement.captureStream, every engine has canvas.captureStream) and, when asked for sound, the video's sound
// through Web Audio. The video loops, so a take can run as long as the driver wants. The driver can read how often the
// page asked, and with what, from window.__camera.
(() => {
  const c = window.__check;
  const name = c.params.camera || c.fixtures[0];
  if (!name || !navigator.mediaDevices) return;
  const asked = [];
  window.__camera = { asked, name };
  let source = null;
  const start = () => {
    if (source) return source;
    source = (async () => {
      const v = document.createElement("video");
      v.src = c.fixtureUrl(name);
      v.muted = true; v.loop = true; v.playsInline = true; v.crossOrigin = "anonymous";
      await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error(`camera fixture ${name} would not load`)); });
      await v.play();
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      const g = canvas.getContext("2d");
      const draw = () => { g.drawImage(v, 0, 0); requestAnimationFrame(draw); };
      draw();
      return { v, canvas };
    })();
    return source;
  };
  const fake = async (constraints = {}) => {
    asked.push(JSON.parse(JSON.stringify(constraints)));
    const { v, canvas } = await start();
    const stream = new MediaStream();
    if (constraints.video) for (const t of canvas.captureStream(30).getVideoTracks()) stream.addTrack(t);
    if (constraints.audio) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      v.muted = false;
      ctx.createMediaElementSource(v).connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    return stream;
  };
  navigator.mediaDevices.getUserMedia = fake;
  navigator.mediaDevices.enumerateDevices = async () => [{ deviceId: "fixture", groupId: "fixture", kind: "videoinput", label: `fixture ${name}`, toJSON() { return this; } }];
})();
