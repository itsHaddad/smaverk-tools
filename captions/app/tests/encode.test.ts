import { test, expect } from "bun:test";
import { pickBitrate, snapFps } from "../src/lib/encode";

test("encode: bitrate follows pixels and frame rate within bounds", () => {
  expect(pickBitrate(1080, 1920, 30)).toBe(6_220_800);
  expect(pickBitrate(720, 1280, 30)).toBe(2_764_800);
  expect(pickBitrate(480, 854, 24)).toBe(1_500_000); // floor
  expect(pickBitrate(2160, 3840, 60)).toBe(10_000_000); // cap
});

test("encode: frame rate snaps to the usual values", () => {
  expect(snapFps(29.97)).toBe(30); expect(snapFps(23.98)).toBe(24); expect(snapFps(24.02)).toBe(24);
  expect(snapFps(15.2)).toBe(15.2); expect(snapFps(null)).toBe(30); expect(snapFps(0)).toBe(30);
});
