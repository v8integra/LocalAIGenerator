import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { generateAudio } from "./audioClient";
import { FakeAudioServer } from "./testFixtures/fakeAudioServer";

test("generateAudio succeeds and the server receives the right request shape", async () => {
  const server = new FakeAudioServer();
  const url = await server.listen();
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "audio-client-test-")), "out.wav");

  await generateAudio(url, { prompt: "a calm piano melody", durationSeconds: 12, outputPath });

  assert.deepEqual(server.lastRequestBody, {
    prompt: "a calm piano melody",
    duration_seconds: 12,
    output_path: outputPath
  });
  const written = await fs.readFile(outputPath);
  assert.ok(written.length > 0);

  await server.close();
});

test("generateAudio throws a clear error on failure", async () => {
  const server = new FakeAudioServer();
  const url = await server.listen();
  const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "audio-client-test-")), "out.wav");

  await assert.rejects(
    () => generateAudio(url, { prompt: "FORCE_ERROR", durationSeconds: 8, outputPath }),
    /Audio generation failed: forced failure for testing/
  );

  await server.close();
});
