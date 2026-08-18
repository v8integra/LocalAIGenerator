import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildOutputFilename } from "./outputFilename";

test("matches the expected prefix_date_time_unique.ext shape", () => {
  const filename = buildOutputFilename("image", ".png");
  assert.match(filename, /^image_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}\.png$/);
});

test("two calls in the same instant still produce distinct filenames", () => {
  // Regression test: this used to be minute-only, so two generations
  // completing in the same minute got the identical filename — silently
  // overwriting the first file, and leaving the renderer pointed at a
  // file:// URL Chromium could serve from cache instead of the new bytes.
  const a = buildOutputFilename("video", ".gif");
  const b = buildOutputFilename("video", ".gif");
  assert.notEqual(a, b);
});
