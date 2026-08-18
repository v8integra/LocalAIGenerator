/** Node ID that must hold the VHS_VideoCombine node — generate.ts reads its "gifs" output by this ID. */
export const VIDEO_COMBINE_NODE_ID = "9";

export interface Txt2VideoParams {
  checkpointFilename: string;
  /** Motion module filename AnimateDiff-Evolved should load, from its animatediff_models folder. */
  motionModelFilename: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
  /**
   * AnimateDiff's motion modules are trained on 16-frame windows — beyond
   * that, without context windowing, output degrades badly (verified
   * live: same prompt/model, sharp recognizable video at 16 frames vs. an
   * indistinct blurry streak at 32). A context-options node slides a
   * context-length window across the full frame count so longer clips
   * stay within the trained window throughout. Matches the node's own
   * defaults (context_length 16, context_overlap 4, context_stride 1).
   */
  contextLength?: number;
  contextOverlap?: number;
  contextStride?: number;
}

/**
 * Builds a ComfyUI API-format graph for AnimateDiff: checkpoint load ->
 * positive/negative CLIP encode -> AnimateDiff model patch (with a
 * sliding context window so any frame count stays coherent) -> batched
 * empty latent -> KSampler -> VAE decode -> VHS_VideoCombine (assembled
 * as an animated GIF via Pillow, not ffmpeg — no video codec dependency
 * needed for this path). Node class names and input fields verified
 * against ComfyUI-AnimateDiff-Evolved's and ComfyUI-VideoHelperSuite's
 * own source, not guessed.
 *
 * Uses ADE_StandardUniformContextOptions, not the simpler
 * ADE_StandardStaticContextOptions this used originally — Static marches
 * through fixed, mostly non-overlapping windows in sequence, and a real
 * generation showed exactly the failure mode you'd expect from that: sharp,
 * coherent motion *within* each ~16-frame window, then a jarring "jump cut"
 * to an unrelated pose/composition at each window boundary (verified by
 * extracting evenly-spaced frames from a real GIF output — a running dog
 * abruptly became a seated dog right at the frame-15/16 boundary). Uniform
 * context staggers window placement across denoising steps instead of using
 * the same fixed windows every step, letting information propagate across
 * the whole sequence rather than being walled off per-window — the standard
 * choice in AnimateDiff-Evolved's own node set for longer, more globally
 * coherent clips.
 *
 * Sampling defaults (steps=4, cfg=1.5) match the 4-step Lightning variant
 * this app downloads — ByteDance's own model card recommends a step count
 * matching the variant and a low CFG, similar in spirit to SDXL Turbo's
 * defaults in buildTxt2ImgWorkflow.ts.
 */
export function buildTxt2VideoWorkflow(params: Txt2VideoParams): Record<string, unknown> {
  const {
    checkpointFilename,
    motionModelFilename,
    prompt,
    negativePrompt = "",
    width = 512,
    height = 512,
    numFrames = 16,
    frameRate = 8,
    steps = 4,
    cfg = 1.5,
    samplerName = "euler",
    scheduler = "normal",
    seed = Math.floor(Math.random() * 2 ** 32),
    filenamePrefix = "LocalAIStudio",
    contextLength = 16,
    contextOverlap = 4,
    contextStride = 1
  } = params;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpointFilename } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["1", 1] } },
    "8": {
      class_type: "ADE_StandardUniformContextOptions",
      inputs: {
        context_length: contextLength,
        context_stride: contextStride,
        context_overlap: contextOverlap,
        fuse_method: "pyramid"
      }
    },
    "4": {
      class_type: "ADE_AnimateDiffLoaderGen1",
      inputs: {
        model: ["1", 0],
        model_name: motionModelFilename,
        beta_schedule: "autoselect",
        context_options: ["8", 0]
      }
    },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: numFrames } },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        denoise: 1,
        model: ["4", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["5", 0]
      }
    },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    [VIDEO_COMBINE_NODE_ID]: {
      class_type: "VHS_VideoCombine",
      inputs: {
        images: ["7", 0],
        frame_rate: frameRate,
        loop_count: 0,
        filename_prefix: filenamePrefix,
        format: "image/gif",
        pingpong: false,
        save_output: true
      }
    }
  };
}
