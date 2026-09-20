// encode.ts: numbers for the fast save (pure, tested).

/** Bits per second for an H.264-class encode at this size and frame rate: about 0.1 bit per pixel per frame, kept between 1.5 and 10 Mbit/s. */
export function pickBitrate(width: number, height: number, fps: number): number {
  const bpp = 0.1; const raw = width * height * Math.max(10, Math.min(60, fps || 30)) * bpp;
  return Math.round(Math.max(1_500_000, Math.min(10_000_000, raw)));
}

/** Frames per second from a packet rate, snapped to the usual values when close. */
export function snapFps(rate: number | null | undefined): number {
  const r = rate && isFinite(rate) && rate > 1 ? rate : 30;
  for (const f of [24, 25, 30, 50, 60]) if (Math.abs(r - f) < 0.6) return f;
  return Math.round(r * 100) / 100;
}
