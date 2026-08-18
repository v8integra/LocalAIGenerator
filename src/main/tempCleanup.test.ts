import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { resetTempDir } from "./tempCleanup";

test("clears leftover files from a previous session", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "temp-cleanup-test-"));
  const tempDir = path.join(base, "temp");
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(path.join(tempDir, "leftover.png"), "stale data from a crashed session");

  await resetTempDir(tempDir);

  const entries = await fs.readdir(tempDir);
  assert.deepEqual(entries, []);
});

test("creates the temp directory if it doesn't exist yet", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "temp-cleanup-test-"));
  const tempDir = path.join(base, "temp");

  await resetTempDir(tempDir);

  const stat = await fs.stat(tempDir);
  assert.equal(stat.isDirectory(), true);
});
