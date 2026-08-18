import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { generate, GenerateContext } from "./generate";
import { FakeComfyServer } from "./testFixtures/fakeComfyServer";

async function tmpOutputDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "generate-test-"));
}

function baseContext(comfyBaseUrl: string, outputDir: string): GenerateContext {
  return {
    comfyBaseUrl,
    outputDir,
    resolveCheckpointFilename: (modelId) => `${modelId}.safetensors`
  };
}

function videoContext(comfyBaseUrl: string, outputDir: string): GenerateContext {
  return {
    ...baseContext(comfyBaseUrl, outputDir),
    resolveCheckpointFilename: () => "sd15.safetensors",
    resolveMotionModelFilename: (modelId) => `${modelId}.safetensors`
  };
}

function img2imgContext(comfyBaseUrl: string, outputDir: string): GenerateContext {
  return {
    ...baseContext(comfyBaseUrl, outputDir),
    stageInputImage: async (sourceImagePath) => `staged_${path.basename(sourceImagePath)}`
  };
}

test("generates an image end to end and writes it to the output directory", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate("text-to-image", "sdxl-turbo", { prompt: "a cat" }, baseContext(url, outputDir));

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.match(path.basename(result.output_path), /^image_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}\.png$/);
    const written = await fs.readFile(result.output_path);
    assert.deepEqual(written, server.fakeImageBytes);
  }

  assert.equal(
    (server.lastReceivedWorkflow as any)?.["1"]?.inputs?.ckpt_name,
    "sdxl-turbo.safetensors",
    "resolved checkpoint filename should reach the submitted workflow"
  );

  await server.close();
});

test("returns a clear not-implemented error for task types this module doesn't handle", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate("text-to-music", "musicgen-small", { prompt: "a cat" }, baseContext(url, outputDir));

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /not implemented yet/);
  }

  await server.close();
});

test("returns a clear error for image-to-image when no input-image staging is configured", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "image-to-image",
    "sdxl-turbo-img2img",
    { prompt: "a cat", sourceImagePath: "C:\\fake\\source.png" },
    baseContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /No input-image staging configured/);
  }

  await server.close();
});

test("returns a clear error for image-to-image when no source image is given", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "image-to-image",
    "sdxl-turbo-img2img",
    { prompt: "a cat", sourceImagePath: "" },
    img2imgContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /needs a source image/);
  }

  await server.close();
});

test("returns a clear error for text-to-video when no motion model resolver is configured", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate("text-to-video", "animatediff-lightning", { prompt: "a cat" }, baseContext(url, outputDir));

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /No motion model resolver configured/);
  }

  await server.close();
});

test("returns an error when ComfyUI execution fails", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 20;
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "text-to-image",
    "sdxl-turbo",
    { prompt: "FORCE_ERROR" },
    baseContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /forced failure for testing/);
  }

  await server.close();
});

test("returns an error when ComfyUI rejects the prompt at submission time", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "text-to-image",
    "sdxl-turbo",
    { prompt: "FORCE_INVALID_PROMPT" },
    baseContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /ComfyUI rejected the prompt/);
  }

  await server.close();
});

test("generates a video end to end, resolving both the checkpoint and motion model filenames", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "text-to-video",
    "animatediff-lightning",
    { prompt: "a cat running" },
    videoContext(url, outputDir)
  );

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.match(path.basename(result.output_path), /^video_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}\.gif$/);
    const written = await fs.readFile(result.output_path);
    assert.deepEqual(written, server.fakeImageBytes);
  }

  const workflow = server.lastReceivedWorkflow as any;
  assert.equal(workflow["1"].inputs.ckpt_name, "sd15.safetensors");
  const motionNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "ADE_AnimateDiffLoaderGen1")!;
  assert.equal(workflow[motionNodeId].inputs.model_name, "animatediff-lightning.safetensors");

  await server.close();
});

test("converts the duration slider's seconds into a frame count for the workflow", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  await generate(
    "text-to-video",
    "animatediff-lightning",
    { prompt: "a cat running", durationSeconds: 1 },
    videoContext(url, outputDir)
  );

  const workflow = server.lastReceivedWorkflow as any;
  const latentNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "EmptyLatentImage")!;
  // 1 second * the default 8fps = 8 frames — under the 16-frame cap, so the conversion isn't clamped.
  assert.equal(workflow[latentNodeId].inputs.batch_size, 8);

  await server.close();
});

test("frame counts beyond 16 still wire in Context Options, so longer clips stay coherent", async () => {
  // Regression test for a real quality bug: AnimateDiff's motion modules
  // are trained on 16-frame windows. Verified live that the exact same
  // prompt/model produced a sharp, recognizable video at 16 frames and an
  // indistinct, blurry streak at 32 with no context windowing — and sharp,
  // coherent frames throughout a 48-frame (3x window) clip once Context
  // Options was wired into the AnimateDiff loader (upgraded from
  // ADE_StandardStaticContextOptions to ADE_StandardUniformContextOptions
  // after a later real generation showed Static's fixed windows still
  // produce a "jump cut" at each window boundary). This just confirms the
  // wiring reaches the workflow; the coherence claim itself was verified
  // against real ComfyUI output, not something a fixture-server test can
  // check.
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  await generate(
    "text-to-video",
    "animatediff-lightning",
    { prompt: "a cat running", durationSeconds: 10 },
    videoContext(url, outputDir)
  );

  const workflow = server.lastReceivedWorkflow as any;
  const latentNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "EmptyLatentImage")!;
  // 10 seconds * 8fps = 80 frames — well under the 240-frame cap now that
  // Context Options handles coherence, so the conversion isn't clamped.
  assert.equal(workflow[latentNodeId].inputs.batch_size, 80);

  const contextNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "ADE_StandardUniformContextOptions")!;
  assert.ok(contextNodeId, "expected an ADE_StandardUniformContextOptions node in the workflow");

  const motionNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "ADE_AnimateDiffLoaderGen1")!;
  assert.deepEqual(workflow[motionNodeId].inputs.context_options, [contextNodeId, 0]);

  await server.close();
});

test("returns an error when text-to-video generation fails in ComfyUI", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 20;
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "text-to-video",
    "animatediff-lightning",
    { prompt: "FORCE_ERROR" },
    videoContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /forced failure for testing/);
  }

  await server.close();
});

test("generates an image-to-image result end to end, staging the source image first", async () => {
  const server = new FakeComfyServer();
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "image-to-image",
    "sdxl-turbo-img2img",
    { prompt: "a cat, oil painting", sourceImagePath: "C:\\Users\\test\\Pictures\\photo.png" },
    img2imgContext(url, outputDir)
  );

  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.match(path.basename(result.output_path), /^image_\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{6}\.png$/);
    const written = await fs.readFile(result.output_path);
    assert.deepEqual(written, server.fakeImageBytes);
  }

  const workflow = server.lastReceivedWorkflow as any;
  assert.equal(workflow["1"].inputs.ckpt_name, "sdxl-turbo-img2img.safetensors");
  const loadImageNodeId = Object.keys(workflow).find((id) => workflow[id].class_type === "LoadImage")!;
  assert.equal(workflow[loadImageNodeId].inputs.image, "staged_photo.png");

  await server.close();
});

test("returns an error when image-to-image generation fails in ComfyUI", async () => {
  const server = new FakeComfyServer();
  server.completionDelayMs = 20;
  const { url } = await server.listen();
  const outputDir = await tmpOutputDir();

  const result = await generate(
    "image-to-image",
    "sdxl-turbo-img2img",
    { prompt: "FORCE_ERROR", sourceImagePath: "C:\\Users\\test\\Pictures\\photo.png" },
    img2imgContext(url, outputDir)
  );

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /forced failure for testing/);
  }

  await server.close();
});
