import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildTxt2ImgWorkflow, SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

test("builds a graph with the expected node chain and checkpoint", () => {
  const workflow = buildTxt2ImgWorkflow({ checkpointFilename: "sd_xl_turbo_1.0_fp16.safetensors", prompt: "a cat" });
  const nodes = workflow as Record<string, WorkflowNode>;

  const checkpointNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "CheckpointLoaderSimple");
  assert.ok(checkpointNodeId);
  assert.equal(nodes[checkpointNodeId!].inputs.ckpt_name, "sd_xl_turbo_1.0_fp16.safetensors");

  assert.equal(nodes[SAVE_IMAGE_NODE_ID].class_type, "SaveImage");

  const positiveNodeId = Object.keys(nodes).find(
    (id) => nodes[id].class_type === "CLIPTextEncode" && nodes[id].inputs.text === "a cat"
  );
  assert.ok(positiveNodeId);
});

test("every node-id link in the graph points at a node that actually exists", () => {
  const workflow = buildTxt2ImgWorkflow({ checkpointFilename: "model.safetensors", prompt: "a dog" });
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

test("applies custom dimensions, sampling params, and negative prompt", () => {
  const workflow = buildTxt2ImgWorkflow({
    checkpointFilename: "model.safetensors",
    prompt: "a mountain",
    negativePrompt: "blurry",
    width: 1024,
    height: 768,
    steps: 4,
    cfg: 1,
    samplerName: "euler_ancestral",
    scheduler: "sgm_uniform",
    seed: 42
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const latentNode = Object.values(nodes).find((n) => n.class_type === "EmptyLatentImage")!;
  assert.equal(latentNode.inputs.width, 1024);
  assert.equal(latentNode.inputs.height, 768);

  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;
  assert.equal(samplerNode.inputs.steps, 4);
  assert.equal(samplerNode.inputs.cfg, 1);
  assert.equal(samplerNode.inputs.sampler_name, "euler_ancestral");
  assert.equal(samplerNode.inputs.scheduler, "sgm_uniform");
  assert.equal(samplerNode.inputs.seed, 42);

  const negativeNodeId = Object.keys(nodes).find(
    (id) => nodes[id].class_type === "CLIPTextEncode" && nodes[id].inputs.text === "blurry"
  );
  assert.ok(negativeNodeId);
});

test("randomizes the seed by default across calls", () => {
  const a = buildTxt2ImgWorkflow({ checkpointFilename: "model.safetensors", prompt: "x" });
  const b = buildTxt2ImgWorkflow({ checkpointFilename: "model.safetensors", prompt: "x" });
  const nodesA = a as Record<string, WorkflowNode>;
  const nodesB = b as Record<string, WorkflowNode>;

  const seedA = Object.values(nodesA).find((n) => n.class_type === "KSampler")!.inputs.seed;
  const seedB = Object.values(nodesB).find((n) => n.class_type === "KSampler")!.inputs.seed;

  assert.notEqual(seedA, seedB);
});
