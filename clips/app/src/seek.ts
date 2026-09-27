// seek.ts: a thin scrub line along the bottom edge of the stage (the principal, 2026-09-18: "very basic video control on the
// video, make it elegant, for example if someone wants to go through the video"). It is a range input, so keys and screen
// readers work; the line is 4 px (8 px while held) and the touch area 44 px. The same file in every tool (tests/site.test.ts).
export function attachSeek(input: HTMLInputElement, bar: HTMLElement, video: HTMLVideoElement) {
  let held = false;
  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const length = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
  const paint = () => { bar.style.setProperty("--p", Number(input.value) / 10 + "%"); input.setAttribute("aria-valuetext", `${clock(video.currentTime || 0)} of ${clock(length())}`); };
  input.addEventListener("input", () => { const d = length(); if (d) video.currentTime = Math.min(d - 0.05, (Number(input.value) / 1000) * d); paint(); });
  input.addEventListener("pointerdown", () => { held = true; input.classList.add("held"); });
  for (const ev of ["pointerup", "pointercancel", "blur"]) input.addEventListener(ev, () => { held = false; input.classList.remove("held"); });
  (function loop() { const d = length(); if (!held && d) { const v = String(Math.round(Math.min(1, video.currentTime / d) * 1000)); if (v !== input.value) { input.value = v; paint(); } } requestAnimationFrame(loop); })();
  paint();
}
