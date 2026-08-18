import * as crypto from "crypto";

/**
 * Matches spec §4.5's example naming (image_2026-07-30_1432.png) with a
 * short random suffix added. Minute-only timestamps collide easily — two
 * generations finishing in the same minute (common with fast models, or
 * just two quick generations back to back) got the exact same filename,
 * silently overwriting the first file's bytes on disk. Worse, the renderer
 * then pointed a new <img>/<audio> element at that same file:// URL, which
 * Chromium can serve from cache without noticing the underlying file
 * changed — the previous result stayed on screen even though a real new
 * generation had completed. The suffix guarantees a distinct URL (and
 * distinct file) per generation, not just a lower collision chance.
 */
export function buildOutputFilename(prefix: string, ext: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const uniquePart = crypto.randomBytes(3).toString("hex");
  return `${prefix}_${datePart}_${timePart}_${uniquePart}${ext}`;
}
