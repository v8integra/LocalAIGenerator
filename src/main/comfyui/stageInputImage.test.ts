import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { stageInputImage } from "./stageInputImage";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "stage-input-image-test-"));
}

test("copies the source file into engineDir/input and returns its new filename", async () => {
  const sourceDir = await tmpDir();
  const engineDir = await tmpDir();
  const sourcePath = path.join(sourceDir, "photo.png");
  await fs.writeFile(sourcePath, "fake-png-bytes");

  const filename = await stageInputImage(sourcePath, engineDir);

  assert.match(filename, /^upload_\d+_[0-9a-f]+\.png$/);
  const staged = await fs.readFile(path.join(engineDir, "input", filename));
  assert.equal(staged.toString(), "fake-png-bytes");
});

test("creates the input directory if it doesn't exist yet", async () => {
  const sourceDir = await tmpDir();
  const engineDir = path.join(await tmpDir(), "not-created-yet");
  const sourcePath = path.join(sourceDir, "photo.jpg");
  await fs.writeFile(sourcePath, "fake-jpg-bytes");

  const filename = await stageInputImage(sourcePath, engineDir);

  const staged = await fs.readFile(path.join(engineDir, "input", filename));
  assert.equal(staged.toString(), "fake-jpg-bytes");
});

test("two stagings of the same source file get distinct filenames", async () => {
  const sourceDir = await tmpDir();
  const engineDir = await tmpDir();
  const sourcePath = path.join(sourceDir, "photo.png");
  await fs.writeFile(sourcePath, "fake-png-bytes");

  const first = await stageInputImage(sourcePath, engineDir);
  const second = await stageInputImage(sourcePath, engineDir);

  assert.notEqual(first, second);
});
