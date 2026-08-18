import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildImg2ImgWorkflow } from "./buildImg2ImgWorkflow";
import { SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

test("builds a graph that loads the source image and feeds it through VAEEncode, not EmptyLatentImage", () => {
  const workflow = buildImg2ImgWorkflow({
    checkpointFilename: "sd_xl_turbo_1.0_fp16.safetensors",
    imageFilename: "upload_123.png",
    prompt: "a cat, oil painting"
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const loadImageNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "LoadImage");
  assert.ok(loadImageNodeId);
  assert.equal(nodes[loadImageNodeId!].inputs.image, "upload_123.png");

  const vaeEncodeNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "VAEEncode");
  assert.ok(vaeEncodeNodeId);
  assert.deepEqual(nodes[vaeEncodeNodeId!].inputs.pixels, [loadImageNodeId, 0]);

  assert.equal(
    Object.values(nodes).some((n) => n.class_type === "EmptyLatentImage"),
    false,
    "img2img should start from the encoded source image, not a blank latent"
  );

  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;
  assert.deepEqual(samplerNode.inputs.latent_image, [vaeEncodeNodeId, 0]);

  assert.equal(nodes[SAVE_IMAGE_NODE_ID].class_type, "SaveImage");
});

test("every node-id link in the graph points at a node that actually exists", () => {
  const workflow = buildImg2ImgWorkflow({
    checkpointFilename: "model.safetensors",
    imageFilename: "upload.png",
    prompt: "a dog jumping"
  });
  const nodes = workflow as Record<string, WorkflowNode>;
  const nodeIds = new Set(Object.keys(nodes));

  for (const node of Object.values(nodes)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string") {
        assert.ok(nodeIds.has(value[0]), `link to missing node "${value[0]}"`);
      }
    }
  }
});

test("defaults denoise below 1 so the result actually resembles the source image", () => {
  const workflow = buildImg2ImgWorkflow({
    checkpointFilename: "model.safetensors",
    imageFilename: "upload.png",
    prompt: "x"
  });
  const nodes = workflow as Record<string, WorkflowNode>;
  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;

  assert.ok((samplerNode.inputs.denoise as number) < 1);
  assert.ok((samplerNode.inputs.denoise as number) > 0);
});

test("applies a custom denoise strength and sampling params", () => {
  const workflow = buildImg2ImgWorkflow({
    checkpointFilename: "model.safetensors",
    imageFilename: "upload.png",
    prompt: "a bird flying",
    denoise: 0.4,
    steps: 8,
    cfg: 3,
    seed: 42
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;
  assert.equal(samplerNode.inputs.denoise, 0.4);
  assert.equal(samplerNode.inputs.steps, 8);
  assert.equal(samplerNode.inputs.cfg, 3);
  assert.equal(samplerNode.inputs.seed, 42);
});
