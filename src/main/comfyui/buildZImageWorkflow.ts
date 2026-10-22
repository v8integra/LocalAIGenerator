import { SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";

export interface ZImageParams {
  diffusionModelFilename: string;
  textEncoderFilename: string;
  vaeFilename: string;
  prompt: string;
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
 * Builds a ComfyUI API-format txt2img graph for Z-Image Turbo, mirroring
 * Comfy-Org's own image_z_image_turbo template: separate UNET / CLIP
 * (Qwen3-4B, loaded as type "lumina2") / VAE loaders, AuraFlow-style
 * model sampling with shift 3, and an 8-step res_multistep KSampler at
 * CFG 1. The model is distilled to run without CFG, so there's no
 * negative prompt — ConditioningZeroOut supplies the empty negative the
 * KSampler still requires. Native resolution is ~1 megapixel.
 */
export function buildZImageWorkflow(params: ZImageParams): Record<string, unknown> {
  const {
    diffusionModelFilename,
    textEncoderFilename,
    vaeFilename,
    prompt,
    width = 1024,
    height = 1024,
    steps = 8,
    cfg = 1,
    samplerName = "res_multistep",
    scheduler = "simple",
    seed = Math.floor(Math.random() * 2 ** 32),
    filenamePrefix = "LocalAIStudio"
  } = params;

  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: diffusionModelFilename, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: textEncoderFilename, type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: vaeFilename } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    "7": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        denoise: 1,
        model: ["4", 0],
        positive: ["5", 0],
        negative: ["6", 0],
        latent_image: ["7", 0]
      }
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    [SAVE_IMAGE_NODE_ID]: { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: filenamePrefix } }
  };
}
