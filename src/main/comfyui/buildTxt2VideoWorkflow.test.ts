import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildTxt2VideoWorkflow, VIDEO_COMBINE_NODE_ID } from "./buildTxt2VideoWorkflow";

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

test("builds a graph with the checkpoint, motion module, and video combine node", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "v1-5-pruned-emaonly.safetensors",
    motionModelFilename: "animatediff_lightning_4step_comfyui.safetensors",
    prompt: "a cat running"
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const checkpointNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "CheckpointLoaderSimple");
  assert.ok(checkpointNodeId);
  assert.equal(nodes[checkpointNodeId!].inputs.ckpt_name, "v1-5-pruned-emaonly.safetensors");

  const motionNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "ADE_AnimateDiffLoaderGen1");
  assert.ok(motionNodeId);
  assert.equal(nodes[motionNodeId!].inputs.model_name, "animatediff_lightning_4step_comfyui.safetensors");

  assert.equal(nodes[VIDEO_COMBINE_NODE_ID].class_type, "VHS_VideoCombine");
  assert.equal(nodes[VIDEO_COMBINE_NODE_ID].inputs.format, "image/gif");

  const positiveNodeId = Object.keys(nodes).find(
    (id) => nodes[id].class_type === "CLIPTextEncode" && nodes[id].inputs.text === "a cat running"
  );
  assert.ok(positiveNodeId);
});

test("every node-id link in the graph points at a node that actually exists", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "model.safetensors",
    motionModelFilename: "motion.safetensors",
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

test("the AnimateDiff-patched model feeds KSampler, not the raw checkpoint model", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "model.safetensors",
    motionModelFilename: "motion.safetensors",
    prompt: "x"
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const motionNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "ADE_AnimateDiffLoaderGen1")!;
  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;

  assert.deepEqual(samplerNode.inputs.model, [motionNodeId, 0]);
});

test("applies custom frame count, dimensions, and sampling params", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "model.safetensors",
    motionModelFilename: "motion.safetensors",
    prompt: "a bird flying",
    numFrames: 24,
    frameRate: 12,
    width: 768,
    height: 512,
    steps: 6,
    cfg: 2,
    seed: 42
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const latentNode = Object.values(nodes).find((n) => n.class_type === "EmptyLatentImage")!;
  assert.equal(latentNode.inputs.batch_size, 24);
  assert.equal(latentNode.inputs.width, 768);
  assert.equal(latentNode.inputs.height, 512);

  const samplerNode = Object.values(nodes).find((n) => n.class_type === "KSampler")!;
  assert.equal(samplerNode.inputs.steps, 6);
  assert.equal(samplerNode.inputs.cfg, 2);
  assert.equal(samplerNode.inputs.seed, 42);

  assert.equal(nodes[VIDEO_COMBINE_NODE_ID].inputs.frame_rate, 12);
});

test("wires a sliding Context Options window into the AnimateDiff loader, defaulting to the model's trained 16-frame window", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "model.safetensors",
    motionModelFilename: "motion.safetensors",
    prompt: "a cat running"
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const contextNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "ADE_StandardUniformContextOptions")!;
  assert.ok(contextNodeId, "expected an ADE_StandardUniformContextOptions node");
  assert.equal(nodes[contextNodeId].inputs.context_length, 16);
  assert.equal(nodes[contextNodeId].inputs.context_overlap, 4);
  assert.equal(nodes[contextNodeId].inputs.context_stride, 1);

  const motionNodeId = Object.keys(nodes).find((id) => nodes[id].class_type === "ADE_AnimateDiffLoaderGen1")!;
  assert.deepEqual(nodes[motionNodeId].inputs.context_options, [contextNodeId, 0]);
});

test("applies a custom context length, overlap, and stride", () => {
  const workflow = buildTxt2VideoWorkflow({
    checkpointFilename: "model.safetensors",
    motionModelFilename: "motion.safetensors",
    prompt: "a cat running",
    contextLength: 8,
    contextOverlap: 2,
    contextStride: 2
  });
  const nodes = workflow as Record<string, WorkflowNode>;

  const contextNode = Object.values(nodes).find((n) => n.class_type === "ADE_StandardUniformContextOptions")!;
  assert.equal(contextNode.inputs.context_length, 8);
  assert.equal(contextNode.inputs.context_overlap, 2);
  assert.equal(contextNode.inputs.context_stride, 2);
});
