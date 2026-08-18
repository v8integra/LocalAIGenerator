import { test } from "node:test";
import * as assert from "node:assert/strict";
import { fetchImage, getHistory, queuePrompt, waitForCompletion } from "./comfyClient";
import { FakeComfyServer } from "./testFixtures/fakeComfyServer";

function textEncodeWorkflow(text: string): Record<string, unknown> {
  return {
    "1": { class_type: "CLIPTextEncode", inputs: { text } }
  };
}

test("queuePrompt returns a prompt_id for a valid workflow", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();

  const result = await queuePrompt(url, textEncodeWorkflow("a cat"), "test-client");

  assert.ok(result.promptId.length > 0);
  assert.deepEqual(result.nodeErrors, {});

  await server.close();
});

test("queuePrompt throws a clear error when ComfyUI rejects the prompt", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();

  await assert.rejects(
    () => queuePrompt(url, textEncodeWorkflow("FORCE_INVALID_PROMPT"), "test-client"),
    /ComfyUI rejected the prompt: forced validation rejection for testing/
  );

  await server.close();
});

test("getHistory returns null while the prompt is still running", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 5000; // long enough that it won't finish during this test
  const { url } = await server.listen();

  const { promptId } = await queuePrompt(url, textEncodeWorkflow("a cat"), "test-client");
  const entry = await getHistory(url, promptId);

  assert.equal(entry, null);

  await server.close();
});

test("waitForCompletion resolves with outputs once the prompt succeeds", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 20;
  const { url } = await server.listen();

  const { promptId } = await queuePrompt(url, textEncodeWorkflow("a cat"), "test-client");
  const entry = await waitForCompletion(url, promptId, { pollIntervalMs: 10, timeoutMs: 5000 });

  assert.equal(entry.status?.statusStr, "success");
  assert.equal(entry.status?.completed, true);
  assert.equal(entry.outputs["9"].images?.[0].filename, "fake_output_00001_.png");

  await server.close();
});

test("waitForCompletion resolves (not throws) on an execution failure — completed but status_str error", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 20;
  const { url } = await server.listen();

  const { promptId } = await queuePrompt(url, textEncodeWorkflow("FORCE_ERROR"), "test-client");
  const entry = await waitForCompletion(url, promptId, { pollIntervalMs: 10, timeoutMs: 5000 });

  assert.equal(entry.status?.statusStr, "error");
  assert.equal(entry.status?.completed, true);

  await server.close();
});

test("waitForCompletion times out if the prompt never completes", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 10000;
  const { url } = await server.listen();

  const { promptId } = await queuePrompt(url, textEncodeWorkflow("a cat"), "test-client");

  await assert.rejects(
    () => waitForCompletion(url, promptId, { pollIntervalMs: 20, timeoutMs: 100 }),
    /Timed out waiting for prompt/
  );

  await server.close();
});

test("fetchImage returns the raw output bytes", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();

  const bytes = await fetchImage(url, { filename: "fake_output_00001_.png", subfolder: "", type: "output" });

  assert.deepEqual(bytes, server.fakeImageBytes);

  await server.close();
});
