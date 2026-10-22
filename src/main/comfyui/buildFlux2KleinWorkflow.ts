import { SAVE_IMAGE_NODE_ID } from "./buildTxt2ImgWorkflow";

export interface Flux2KleinParams {
  diffusionModelFilename: string;
  textEncoderFilename: string;
  vaeFilename: string;
  prompt: string;
  /**
   * Filename inside ComfyUI's own input/ directory (see stageInputImage.ts).
   * When present the graph becomes an instruction-style edit of that image
   * ("make the bag blue") instead of plain text-to-image.
   */
  imageFilename?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  seed?: number;
  filenamePrefix?: string;
}

/**
 * Builds a ComfyUI API-format graph for FLUX.2 [klein] 4B (distilled),
 * mirroring Comfy-Org's image_flux2_klein_text_to_image and
 * image_flux2_klein_image_edit_4b_distilled templates: separate UNET /
 * CLIP (Qwen3-4B, type "flux2") / VAE loaders, Flux2Scheduler sigmas,
 * CFGGuider at CFG 1, and SamplerCustomAdvanced — 4 steps, no negative
 * prompt (ConditioningZeroOut stands in for it).
 *
 * Editing differs from SD-style img2img: rather than partially denoising
 * the source latent, the source is scaled to ~1 megapixel, VAE-encoded,
 * and attached to both conditionings via ReferenceLatent, while sampling
 * still starts from an empty latent sized to match the source.
 */
export function buildFlux2KleinWorkflow(params: Flux2KleinParams): Record<string, unknown> {
  const {
    diffusionModelFilename,
    textEncoderFilename,
    vaeFilename,
    prompt,
    imageFilename,
    width = 1024,
    height = 1024,
    steps = 4,
    cfg = 1,
    samplerName = "euler",
    seed = Math.floor(Math.random() * 2 ** 32),
    filenamePrefix = "LocalAIStudio"
  } = params;

  const graph: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: diffusionModelFilename, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: textEncoderFilename, type: "flux2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: vaeFilename } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: samplerName } },
    "10": { class_type: "RandomNoise", inputs: { noise_seed: seed } }
  };

  // Text-to-image uses the requested size; editing uses the scaled source's own size.
  let latentWidth: number | [string, number] = width;
  let latentHeight: number | [string, number] = height;
  let positive: [string, number] = ["4", 0];
  let negative: [string, number] = ["5", 0];

  if (imageFilename) {
    graph["14"] = { class_type: "LoadImage", inputs: { image: imageFilename } };
    graph["15"] = {
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["14", 0], upscale_method: "nearest-exact", megapixels: 1, resolution_steps: 1 }
    };
    graph["16"] = { class_type: "GetImageSize", inputs: { image: ["15", 0] } };
    graph["17"] = { class_type: "VAEEncode", inputs: { pixels: ["15", 0], vae: ["3", 0] } };
    graph["18"] = { class_type: "ReferenceLatent", inputs: { conditioning: ["4", 0], latent: ["17", 0] } };
    graph["19"] = { class_type: "ReferenceLatent", inputs: { conditioning: ["5", 0], latent: ["17", 0] } };
    latentWidth = ["16", 0];
    latentHeight = ["16", 1];
    positive = ["18", 0];
    negative = ["19", 0];
  }

  graph["6"] = { class_type: "EmptyFlux2LatentImage", inputs: { width: latentWidth, height: latentHeight, batch_size: 1 } };
  graph["7"] = { class_type: "Flux2Scheduler", inputs: { steps, width: latentWidth, height: latentHeight } };
  graph["11"] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive, negative, cfg } };
  graph["12"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["10", 0], guider: ["11", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["6", 0] }
  };
  graph["13"] = { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } };
  graph[SAVE_IMAGE_NODE_ID] = { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: filenamePrefix } };
  return graph;
}
