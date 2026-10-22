import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SAVE_AUDIO_NODE_ID, buildAceStepWorkflow } from "./buildAceStepWorkflow";
import { buildFlux2KleinWorkflow } from "./buildFlux2KleinWorkflow";
import { SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";
import { buildZImageWorkflow } from "./buildZImageWorkflow";

interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

const FILES = {
  diffusionModelFilename: "unet.safetensors",
  textEncoderFilename: "qwen_3_4b_fp8_mixed.safetensors",
  vaeFilename: "vae.safetensors"
};

function nodeOfType(nodes: Record<string, WorkflowNode>, classType: string): WorkflowNode {
  const node = Object.values(nodes).find((n) => n.class_type === classType);
  assert.ok(node, `no ${classType} node in graph`);
  return node!;
}

/** Every [nodeId, outputIndex] link must point at a node that exists — a dangling one only fails inside ComfyUI. */
function assertLinksResolve(nodes: Record<string, WorkflowNode>): void {
  for (const [id, node] of Object.entries(nodes)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number") {
        assert.ok(nodes[value[0]], `node ${id} links to missing node ${value[0]}`);
      }
    }
  }
}

test("Z-Image graph loads the three split files and samples like the official template", () => {
  const nodes = buildZImageWorkflow({ ...FILES, prompt: "a lighthouse" }) as Record<string, WorkflowNode>;

  assert.equal(nodeOfType(nodes, "UNETLoader").inputs.unet_name, "unet.safetensors");
  assert.deepEqual(nodeOfType(nodes, "CLIPLoader").inputs, {
    clip_name: "qwen_3_4b_fp8_mixed.safetensors",
    type: "lumina2",
    device: "default"
  });
  assert.equal(nodeOfType(nodes, "VAELoader").inputs.vae_name, "vae.safetensors");
  assert.equal(nodeOfType(nodes, "ModelSamplingAuraFlow").inputs.shift, 3);

  const sampler = nodeOfType(nodes, "KSampler").inputs;
  assert.equal(sampler.steps, 8);
  assert.equal(sampler.cfg, 1);
  assert.equal(sampler.sampler_name, "res_multistep");
  assert.equal(nodes[SAVE_IMAGE_NODE_ID].class_type, "SaveImage");
  assertLinksResolve(nodes);
});

test("FLUX.2 Klein text-to-image graph uses the custom sampler chain at the requested size", () => {
  const nodes = buildFlux2KleinWorkflow({ ...FILES, prompt: "a fox", width: 768, height: 1024 }) as Record<string, WorkflowNode>;

  assert.equal(nodeOfType(nodes, "CLIPLoader").inputs.type, "flux2");
  assert.deepEqual(nodeOfType(nodes, "Flux2Scheduler").inputs, { steps: 4, width: 768, height: 1024 });
  assert.equal(nodeOfType(nodes, "CFGGuider").inputs.cfg, 1);
  assert.ok(!Object.values(nodes).some((n) => n.class_type === "LoadImage"));
  assert.equal(nodes[SAVE_IMAGE_NODE_ID].class_type, "SaveImage");
  assertLinksResolve(nodes);
});

test("FLUX.2 Klein edit graph references the source image and sizes the latent from it", () => {
  const nodes = buildFlux2KleinWorkflow({ ...FILES, prompt: "make it blue", imageFilename: "input.png" }) as Record<
    string,
    WorkflowNode
  >;

  assert.equal(nodeOfType(nodes, "LoadImage").inputs.image, "input.png");
  const referenceLatents = Object.values(nodes).filter((n) => n.class_type === "ReferenceLatent");
  assert.equal(referenceLatents.length, 2);

  const guider = nodeOfType(nodes, "CFGGuider").inputs;
  for (const link of [guider.positive, guider.negative] as [string, number][]) {
    assert.equal(nodes[link[0]].class_type, "ReferenceLatent");
  }

  const latent = nodeOfType(nodes, "EmptyFlux2LatentImage").inputs;
  const sizeNode = nodes[(latent.width as [string, number])[0]];
  assert.equal(sizeNode.class_type, "GetImageSize");
  assertLinksResolve(nodes);
});

test("ACE-Step graph passes prompt, lyrics and duration through and saves audio", () => {
  const nodes = buildAceStepWorkflow({
    checkpointFilename: "ace.safetensors",
    prompt: "lofi hip hop",
    lyrics: "[Verse]\nhello",
    durationSeconds: 20
  }) as Record<string, WorkflowNode>;

  const encoder = nodeOfType(nodes, "TextEncodeAceStepAudio1.5").inputs;
  assert.equal(encoder.tags, "lofi hip hop");
  assert.equal(encoder.lyrics, "[Verse]\nhello");
  assert.equal(encoder.duration, 20);
  assert.equal(nodeOfType(nodes, "EmptyAceStep1.5LatentAudio").inputs.seconds, 20);
  assert.equal(nodes[SAVE_AUDIO_NODE_ID].class_type, "SaveAudio");
  assertLinksResolve(nodes);
});

test("ACE-Step graph defaults to an instrumental when no lyrics are given", () => {
  const nodes = buildAceStepWorkflow({ checkpointFilename: "ace.safetensors", prompt: "ambient" }) as Record<
    string,
    WorkflowNode
  >;
  assert.equal(nodeOfType(nodes, "TextEncodeAceStepAudio1.5").inputs.lyrics, "[Instrumental]");
});
