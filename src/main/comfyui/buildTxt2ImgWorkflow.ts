/** Node ID that must hold the SaveImage node — generate.ts reads its output by this ID. */
export const SAVE_IMAGE_NODE_ID = "9";

export interface Txt2ImgParams {
  checkpointFilename: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
}

/**
 * Builds a standard ComfyUI API-format txt2img graph: checkpoint load ->
 * positive/negative CLIP encode -> empty latent -> KSampler -> VAE decode
 * -> SaveImage. Sampling defaults are generic SD1.x-style values, not
 * tuned per model — per-model presets (e.g. SDXL Turbo's low-step, low-CFG
 * settings) are a future refinement; callers can override via params.
 */
export function buildTxt2ImgWorkflow(params: Txt2ImgParams): Record<string, unknown> {
  const {
    checkpointFilename,
    prompt,
    negativePrompt = "",
    width = 512,
    height = 512,
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
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0]
      }
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    [SAVE_IMAGE_NODE_ID]: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: filenamePrefix } }
  };
}
