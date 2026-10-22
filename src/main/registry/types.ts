export type TaskType = "text-to-image" | "text-to-video" | "text-to-music" | "image-to-image";
export type EngineType = "comfyui" | "python";
export type ContentPolicy = "strict" | "moderate" | "unrestricted";
export type OsSupport = "windows" | "mac" | "linux";

/**
 * Distilled/turbo-style models (e.g. SDXL Turbo) need sampling parameters
 * far outside standard SD1.x/SDXL defaults — few steps, near-zero CFG —
 * or they produce visibly degraded output despite generating "successfully".
 * width/height cover a related but distinct problem: SDXL's base checkpoint
 * is trained at ~1024x1024 and produces intermittently malformed output
 * (duplicated/warped anatomy, worse on some seeds than others) at
 * buildTxt2ImgWorkflow's generic 512x512 default, which is tuned for SD1.x.
 * Optional because most models are fine with buildTxt2ImgWorkflow's own
 * generic defaults; only present for entries that actually need an override.
 */
export interface SamplingPreset {
  steps: number;
  cfg: number;
  sampler_name?: string;
  scheduler?: string;
  width?: number;
  height?: number;
}

/**
 * Which ComfyUI graph a model needs. "checkpoint" (the default when absent)
 * is the classic single-file SD1.x/SDXL layout that CheckpointLoaderSimple
 * loads whole. The newer families ship as a bare diffusion model plus a
 * separate text encoder and VAE (see ModelComponent), each with its own
 * sampling setup taken from ComfyUI's official workflow templates.
 */
export type WorkflowFamily = "checkpoint" | "z-image" | "flux2-klein" | "ace-step-1.5";
export type ComponentRole = "text_encoder" | "vae";

/**
 * An extra weights file a model needs alongside its main download_url.
 * Saved under its original Hugging Face filename rather than per-entry, so
 * entries that share one (Z-Image and FLUX.2 Klein both use the same
 * Qwen3-4B text encoder) download it only once.
 */
export interface ModelComponent {
  role: ComponentRole;
  download_url: string;
  checksum: string;
}

export interface ModelEntry {
  id: string;
  task: TaskType;
  label: string;
  engine: EngineType;
  min_vram_gb: number;
  recommended_vram_gb: number;
  os_support: OsSupport[];
  disk_gb: number;
  content_policy: ContentPolicy;
  download_url: string;
  checksum: string;
  quality_tier: number;
  is_default_candidate: boolean;
  sampling_preset?: SamplingPreset;
  workflow?: WorkflowFamily;
  components?: ModelComponent[];
}
