import { SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";

export interface Img2ImgParams {
  checkpointFilename: string;
  /** Filename inside ComfyUI's own input/ directory (see stageInputImage.ts) — not an absolute path. */
  imageFilename: string;
  prompt: string;
  negativePrompt?: string;
  /** How much the sampler is allowed to deviate from the source image, 0-1. */
  denoise?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
}

/**
 * Builds a standard ComfyUI API-format img2img graph: checkpoint load ->
 * positive/negative CLIP encode -> load source image -> VAE encode into a
 * starting latent -> KSampler (partial denoise) -> VAE decode -> SaveImage.
 * Sampling defaults are generic SD1.x-style values, not tuned per model —
 * same approach as buildTxt2ImgWorkflow.
 */
export function buildImg2ImgWorkflow(params: Img2ImgParams): Record<string, unknown> {
  const {
    checkpointFilename,
    imageFilename,
    prompt,
    negativePrompt = "",
    denoise = 0.75,
    steps = 20,
    cfg = 7,
    samplerName = "euler",
    scheduler = "normal",
    seed = Math.floor(Math.random() * 2 ** 32),
    filenamePrefix = "LocalAIStudio"
  } = params;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpointFilename } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["1", 1] } },
    "4": { class_type: "LoadImage", inputs: { image: imageFilename } },
    "5": { class_type: "VAEEncode", inputs: { pixels: ["4", 0], vae: ["1", 2] } },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        denoise,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["5", 0]
      }
    },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    [SAVE_IMAGE_NODE_ID]: { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: filenamePrefix } }
  };
}
