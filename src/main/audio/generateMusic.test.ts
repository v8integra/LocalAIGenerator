import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { generateMusic } from "./generateMusic";
import { FakeAudioServer } from "./testFixtures/fakeAudioServer";

async function tmpOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "generate-music-test-"));
}

test("generates a track end to end and writes it to the output directory", async () => {
  const server = new FakeAudioServer();
  const url = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generateMusic({ prompt: "a calm piano melody", durationSeconds: 10 }, { audioBaseUrl: url, outputDir });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.match(path.basename(result.output_path), /^music_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}\.wav$/);
    const written = await fs.readFile(result.output_path);
    assert.ok(written.length > 0);
  }
  assert.equal(server.lastRequestBody.duration_seconds, 10);

  await server.close();
});

test("defaults duration when not provided", async () => {
  const server = new FakeAudioServer();
  const url = await server.listen();
  const outputDir = await tmpOutputDir();

  await generateMusic({ prompt: "a calm piano melody" }, { audioBaseUrl: url, outputDir });

  assert.equal(server.lastRequestBody.duration_seconds, 8);

  await server.close();
});

test("returns a clear error when the audio server fails", async () => {
  const server = new FakeAudioServer();
  const url = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generateMusic({ prompt: "FORCE_ERROR" }, { audioBaseUrl: url, outputDir });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /forced failure for testing/);
  }

  await server.close();
});
