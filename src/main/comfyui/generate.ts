import * as fs from "fs/promises";
import * as path from "path";
import { buildOutputFilename } from "../outputFilename";
import { buildImg2ImgWorkflow } from "./buildImg2ImgWorkflow";
import { buildTxt2ImgWorkflow, SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";
import { buildTxt2VideoWorkflow, VIDEO_COMBINE_NODE_ID } from "./buildTxt2VideoWorkflow";
import { HistoryEntry, fetchImage, queuePrompt, waitForCompletion } from "./comfyClient";

/** text-to-music is a separate engine (src/main/audio/) — only the three ComfyUI-based tasks are handled here. */
export type TaskType = "text-to-image" | "text-to-video" | "text-to-music" | "image-to-image";

export interface TextToImageInputs {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
}

export interface TextToVideoInputs {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  /** From the UI's duration slider — converted to numFrames if numFrames isn't given explicitly. */
  durationSeconds?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
}

export interface ImageToImageInputs {
  prompt: string;
  negativePrompt?: string;
  /** Absolute host path to the user-selected source image — staged into ComfyUI's own input/ dir before use. Required at runtime; typed optional so callers of the other task types don't need to pass it. */
  sourceImagePath?: string;
  denoise?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
}

/**
 * AnimateDiff's motion modules are trained on 16-frame temporal windows,
 * but buildTxt2VideoWorkflow now wires in ADE_StandardUniformContextOptions
 * (a 16-frame sliding window, staggered across denoising steps for global
 * consistency — see buildTxt2VideoWorkflow.ts for why Static wasn't enough
 * on its own), so longer sequences stay coherent instead of degrading —
 * verified live at 48 frames (3x the base window), sharp and correct all
 * the way through, including the last frame. This cap
 * matches the duration slider's 30s max at the default 8fps frame rate;
 * it exists to bound generation time, not to protect quality.
 */
const MAX_VIDEO_FRAMES = 240;
const DEFAULT_VIDEO_NUM_FRAMES = 16;

export type GenerateResult = { status: "success"; output_path: string } | { status: "error"; error: string };

export interface GenerateContext {
  /** Base URL of the running ComfyUI subprocess, e.g. http://127.0.0.1:8188/ */
  comfyBaseUrl: string;
  /** Maps a registry model_id to the checkpoint filename ComfyUI should load. */
  resolveCheckpointFilename: (modelId: string) => string;
  /** text-to-video only — the AnimateDiff motion module filename to pair with the checkpoint. */
  resolveMotionModelFilename?: (modelId: string) => string;
  /** image-to-image only — copies the source image into ComfyUI's input/ dir and returns the filename LoadImage should reference. */
  stageInputImage?: (sourceImagePath: string) => Promise<string>;
  /** Directory generated outputs are written to (spec §4.5's temp directory). */
  outputDir: string;
  clientId?: string;
  timeoutMs?: number;
}

/** The generate(task_type, model_id, inputs) interface from spec §4.4, for the two ComfyUI-based tasks. */
export async function generate(
  taskType: TaskType,
  modelId: string,
  inputs: TextToImageInputs & TextToVideoInputs & ImageToImageInputs,
  context: GenerateContext
): Promise<GenerateResult> {
  if (taskType === "text-to-image") return generateImage(modelId, inputs, context);
  if (taskType === "text-to-video") return generateVideo(modelId, inputs, context);
  if (taskType === "image-to-image") return generateImageToImage(modelId, inputs, context);
  return { status: "error", error: `Task type "${taskType}" is not implemented yet` };
}

async function generateImage(modelId: string, inputs: TextToImageInputs, context: GenerateContext): Promise<GenerateResult> {
  try {
    const checkpointFilename = context.resolveCheckpointFilename(modelId);
    const workflow = buildTxt2ImgWorkflow({ checkpointFilename, ...inputs });

    const entry = await runWorkflow(workflow, context);
    if ("error" in entry) return entry;

    const image = entry.outputs[SAVE_IMAGE_NODE_ID]?.images?.[0];
    if (!image) {
      return { status: "error", error: "ComfyUI reported success but produced no output image" };
    }

    const imageBytes = await fetchImage(context.comfyBaseUrl, image);
    await fs.mkdir(context.outputDir, { recursive: true });
    const ext = path.extname(image.filename) || ".png";
    const outputPath = path.join(context.outputDir, buildOutputFilename("image", ext));
    await fs.writeFile(outputPath, imageBytes);

    return { status: "success", output_path: outputPath };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

async function generateVideo(modelId: string, inputs: TextToVideoInputs, context: GenerateContext): Promise<GenerateResult> {
  try {
    if (!context.resolveMotionModelFilename) {
      return { status: "error", error: "No motion model resolver configured for text-to-video" };
    }
    const checkpointFilename = context.resolveCheckpointFilename(modelId);
    const motionModelFilename = context.resolveMotionModelFilename(modelId);
    const frameRate = inputs.frameRate ?? 8;
    const numFrames =
      inputs.numFrames ??
      (inputs.durationSeconds
        ? Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.round(inputs.durationSeconds * frameRate)))
        : DEFAULT_VIDEO_NUM_FRAMES);
    const workflow = buildTxt2VideoWorkflow({ checkpointFilename, motionModelFilename, ...inputs, numFrames, frameRate });

    const entry = await runWorkflow(workflow, context);
    if ("error" in entry) return entry;

    const gif = entry.outputs[VIDEO_COMBINE_NODE_ID]?.gifs?.[0];
    if (!gif) {
      return { status: "error", error: "ComfyUI reported success but produced no output video" };
    }

    const videoBytes = await fetchImage(context.comfyBaseUrl, gif);
    await fs.mkdir(context.outputDir, { recursive: true });
    const ext = path.extname(gif.filename) || ".gif";
    const outputPath = path.join(context.outputDir, buildOutputFilename("video", ext));
    await fs.writeFile(outputPath, videoBytes);

    return { status: "success", output_path: outputPath };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

async function generateImageToImage(
  modelId: string,
  inputs: ImageToImageInputs,
  context: GenerateContext
): Promise<GenerateResult> {
  try {
    if (!inputs.sourceImagePath) {
      return { status: "error", error: "Image-to-image needs a source image" };
    }
    if (!context.stageInputImage) {
      return { status: "error", error: "No input-image staging configured for image-to-image" };
    }
    const checkpointFilename = context.resolveCheckpointFilename(modelId);
    const imageFilename = await context.stageInputImage(inputs.sourceImagePath);
    const workflow = buildImg2ImgWorkflow({ checkpointFilename, imageFilename, ...inputs });

    const entry = await runWorkflow(workflow, context);
    if ("error" in entry) return entry;

    const image = entry.outputs[SAVE_IMAGE_NODE_ID]?.images?.[0];
    if (!image) {
      return { status: "error", error: "ComfyUI reported success but produced no output image" };
    }

    const imageBytes = await fetchImage(context.comfyBaseUrl, image);
    await fs.mkdir(context.outputDir, { recursive: true });
    const ext = path.extname(image.filename) || ".png";
    const outputPath = path.join(context.outputDir, buildOutputFilename("image", ext));
    await fs.writeFile(outputPath, imageBytes);

    return { status: "success", output_path: outputPath };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

/** Submits a workflow and waits for it, normalizing ComfyUI's success/failure into our result shape. */
async function runWorkflow(
  workflow: Record<string, unknown>,
  context: GenerateContext
): Promise<HistoryEntry | { status: "error"; error: string }> {
  const { promptId } = await queuePrompt(context.comfyBaseUrl, workflow, context.clientId ?? "local-ai-studio");
  const entry = await waitForCompletion(context.comfyBaseUrl, promptId, { timeoutMs: context.timeoutMs });

  if (entry.status?.statusStr !== "success") {
    const detail = entry.status?.messages.join("; ") || "generation failed";
    return { status: "error", error: detail };
  }
  return entry;
}
