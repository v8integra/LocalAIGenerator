/** Node ID that must hold the SaveAudio node — generate.ts reads its "audio" output by this ID. */
export const SAVE_AUDIO_NODE_ID = "9";

export interface AceStepParams {
  checkpointFilename: string;
  /** Style description ("upbeat synthwave, female vocals") — ACE-Step calls these tags. */
  prompt: string;
  /** Song lyrics; "[Instrumental]" asks for a track with no vocals. */
  lyrics?: string;
  durationSeconds?: number;
  bpm?: number;
  keyscale?: string;
  language?: string;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
  filenamePrefix?: string;
}

/**
 * Builds a ComfyUI API-format graph for ACE-Step 1.5 Turbo from its
 * all-in-one checkpoint, mirroring Comfy-Org's
 * audio_ace_step_1_5_checkpoint template: the checkpoint's CLIP feeds
 * TextEncodeAceStepAudio1.5 (style tags + lyrics + musical metadata,
 * with the built-in language model generating audio codes), AuraFlow
 * model sampling at shift 3, an 8-step euler KSampler at CFG 1 with a
 * zeroed negative, then VAEDecodeAudio -> SaveAudio (FLAC).
 * The encoder's own cfg_scale/temperature/top_p values are the
 * template's, which are also the node's defaults.
 */
export function buildAceStepWorkflow(params: AceStepParams): Record<string, unknown> {
  const {
    checkpointFilename,
    prompt,
    lyrics = "[Instrumental]",
    durationSeconds = 30,
    bpm = 120,
    keyscale = "C major",
    language = "en",
    steps = 8,
    cfg = 1,
    samplerName = "euler",
    scheduler = "simple",
    seed = Math.floor(Math.random() * 2 ** 32),
    filenamePrefix = "LocalAIStudio"
  } = params;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpointFilename } },
    "2": {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: ["1", 1],
        tags: prompt,
        lyrics,
        seed,
        bpm,
        duration: durationSeconds,
        timesignature: "4",
        language,
        keyscale,
        generate_audio_codes: true,
        cfg_scale: 2,
        temperature: 0.85,
        top_p: 0.9,
        top_k: 0,
        min_p: 0
      }
    },
    "3": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "5": { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds: durationSeconds, batch_size: 1 } },
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
    "7": { class_type: "VAEDecodeAudio", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    [SAVE_AUDIO_NODE_ID]: { class_type: "SaveAudio", inputs: { audio: ["7", 0], filename_prefix: filenamePrefix } }
  };
}
