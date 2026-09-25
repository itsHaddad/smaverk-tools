// draw.ts: the captions and the free-version mark, drawn onto a frame. Captions draws its stage, its style chips and
// every saved frame with these; Clips burns its captions in with the same calls, so a caption looks the same in both.
import type { Word } from "./lib/lines";

export type Style = "bar" | "karaoke" | "big";
/** The line on screen and the index of the word being spoken in it (-1: between words). */
export type Shown = { ws: Word[]; cur: number } | null;
/** Where the person dragged the captions: fractions of the frame, or null for the style's own place. */
export type Place = { x: number | null; y: number | null };

export const FONT = '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif';

/** One caption line over whatever is already on the canvas. `thumb` is the small style chip: bigger type, fixed place. */
export function drawCaption(c: CanvasRenderingContext2D, W: number, H: number, line: Shown, st: Style, at: Place, thumb = false) {
  const fs = Math.round(Math.min(W, H) * (thumb ? 0.17 : 0.075));
  c.textAlign = "center"; c.textBaseline = "middle"; c.lineJoin = "round";
  if (!line) return;
  const text = line.ws.map((w) => w.text).join(" ");
  const yPos = thumb || at.y === null ? (st === "big" ? 0.71 : st === "bar" ? 0.76 : 0.74) : at.y; // defaults sit above the bottom fifth that Reels and TikTok cover with their own text and buttons
  const cx = thumb || at.x === null ? W / 2 : W * at.x;
  if (st === "bar") {
    c.font = `700 ${fs}px ${FONT}`; const y = H * yPos; const w = Math.min(W - fs, c.measureText(text).width + fs);
    c.fillStyle = "rgba(10,10,14,.78)"; roundRect(c, cx - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.35); c.fillStyle = "#fff"; fitText(c, text, W - fs * 1.6, fs, 700); c.fillText(text, cx, y);
  } else if (st === "karaoke") {
    c.font = `800 ${fs}px ${FONT}`; fitText(c, text, W - fs, fs, 800); const y = H * yPos;
    let x = cx - c.measureText(text).width / 2; c.textAlign = "left"; c.lineWidth = fs * 0.22; c.strokeStyle = "rgba(10,10,14,.9)";
    line.ws.forEach((w, i) => { const s = w.text + " "; c.fillStyle = i === line.cur ? "#FFD84D" : "#fff"; c.strokeText(s, x, y); c.fillText(s, x, y); x += c.measureText(s).width; });
    c.textAlign = "center";
  } else {
    const big = Math.round(fs * 1.45); c.font = `800 ${big}px ${FONT}`; const y = H * yPos; c.lineWidth = big * 0.24; c.strokeStyle = "rgba(10,10,14,.92)"; c.fillStyle = "#fff";
    wrap(c, text, W - big).forEach((ln, i, arr) => { const yy = y + (i - (arr.length - 1) / 2) * big * 1.12; c.strokeText(ln, cx, yy); c.fillText(ln, cx, yy); });
  }
}

/** The small smaverk.com mark in the corner of a free save. */
export function drawMark(c: CanvasRenderingContext2D, W: number, H: number) {
  c.textBaseline = "middle"; c.lineJoin = "round";
  c.font = `700 ${Math.round(Math.min(W, H) * 0.035)}px ${FONT}`; c.textAlign = "right"; c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.5)"; c.fillStyle = "rgba(255,255,255,.85)"; c.strokeText("smaverk.com", W - 12, H - 16); c.fillText("smaverk.com", W - 12, H - 16);
}

function fitText(c: CanvasRenderingContext2D, text: string, maxW: number, fs: number, wt: number) { let f = fs; while (f > fs * 0.5 && c.measureText(text).width > maxW) { f -= 2; c.font = `${wt} ${f}px ${FONT}`; } }
function wrap(c: CanvasRenderingContext2D, text: string, maxW: number) { const out: string[] = []; let cur = ""; for (const w of text.split(" ")) { const t = cur ? cur + " " + w : w; if (c.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out.slice(0, 3); }
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { c.beginPath(); c.roundRect(x, y, w, h, r); c.fill(); }
