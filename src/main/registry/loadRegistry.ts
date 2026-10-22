import * as fs from "fs/promises";
import * as path from "path";
import { ModelEntry, TaskType, EngineType, ContentPolicy, OsSupport, SamplingPreset, WorkflowFamily, ComponentRole } from "./types";

const TASK_TYPES: TaskType[] = ["text-to-image", "text-to-video", "text-to-music", "image-to-image"];
const ENGINE_TYPES: EngineType[] = ["comfyui", "python"];
const CONTENT_POLICIES: ContentPolicy[] = ["strict", "moderate", "unrestricted"];
const OS_VALUES: OsSupport[] = ["windows", "mac", "linux"];
const WORKFLOW_FAMILIES: WorkflowFamily[] = ["checkpoint", "z-image", "flux2-klein", "ace-step-1.5"];
const COMPONENT_ROLES: ComponentRole[] = ["text_encoder", "vae"];

function fail(entry: any, field: string, index: number): never {
  const id = typeof entry?.id === "string" ? entry.id : "unknown";
  throw new Error(`Model registry entry at index ${index} (id: ${id}) has a missing or invalid "${field}" field`);
}

function validateEntry(entry: any, index: number): ModelEntry {
  if (typeof entry.id !== "string" || entry.id.length === 0) fail(entry, "id", index);
  if (!TASK_TYPES.includes(entry.task)) fail(entry, "task", index);
  if (typeof entry.label !== "string" || entry.label.length === 0) fail(entry, "label", index);
  if (!ENGINE_TYPES.includes(entry.engine)) fail(entry, "engine", index);
  if (typeof entry.min_vram_gb !== "number") fail(entry, "min_vram_gb", index);
  if (typeof entry.recommended_vram_gb !== "number") fail(entry, "recommended_vram_gb", index);
  if (!Array.isArray(entry.os_support) || entry.os_support.length === 0 || !entry.os_support.every((o: any) => OS_VALUES.includes(o))) {
    fail(entry, "os_support", index);
  }
  if (typeof entry.disk_gb !== "number") fail(entry, "disk_gb", index);
  if (!CONTENT_POLICIES.includes(entry.content_policy)) fail(entry, "content_policy", index);
  if (typeof entry.download_url !== "string") fail(entry, "download_url", index);
  if (typeof entry.checksum !== "string") fail(entry, "checksum", index);
  if (typeof entry.quality_tier !== "number") fail(entry, "quality_tier", index);
  if (typeof entry.is_default_candidate !== "boolean") fail(entry, "is_default_candidate", index);
  if (entry.sampling_preset !== undefined) validateSamplingPreset(entry, entry.sampling_preset, index);
  if (entry.workflow !== undefined && !WORKFLOW_FAMILIES.includes(entry.workflow)) fail(entry, "workflow", index);
  if (entry.components !== undefined) validateComponents(entry, entry.components, index);
  return entry as ModelEntry;
}

function validateComponents(entry: any, components: any, index: number): void {
  if (!Array.isArray(components)) fail(entry, "components", index);
  components.forEach((component: any, i: number) => {
    if (typeof component !== "object" || component === null) fail(entry, `components[${i}]`, index);
    if (!COMPONENT_ROLES.includes(component.role)) fail(entry, `components[${i}].role`, index);
    if (typeof component.download_url !== "string") fail(entry, `components[${i}].download_url`, index);
    if (typeof component.checksum !== "string") fail(entry, `components[${i}].checksum`, index);
  });
}

function validateSamplingPreset(entry: any, preset: any, index: number): asserts preset is SamplingPreset {
  if (typeof preset !== "object" || preset === null) fail(entry, "sampling_preset", index);
  if (typeof preset.steps !== "number") fail(entry, "sampling_preset.steps", index);
  if (typeof preset.cfg !== "number") fail(entry, "sampling_preset.cfg", index);
  if (preset.sampler_name !== undefined && typeof preset.sampler_name !== "string") {
    fail(entry, "sampling_preset.sampler_name", index);
  }
  if (preset.scheduler !== undefined && typeof preset.scheduler !== "string") {
    fail(entry, "sampling_preset.scheduler", index);
  }
  if (preset.width !== undefined && typeof preset.width !== "number") {
    fail(entry, "sampling_preset.width", index);
  }
  if (preset.height !== undefined && typeof preset.height !== "number") {
    fail(entry, "sampling_preset.height", index);
  }
}

/**
 * Loads and validates a model registry JSON file from an arbitrary path —
 * kept separate from loadBundledRegistry() so it can be unit tested against
 * fixture files without touching the real bundled registry.
 */
export async function loadRegistryFromPath(filePath: string): Promise<ModelEntry[]> {
  const raw = await fs.readFile(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Model registry at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Model registry at ${filePath} must be a JSON array`);
  }

  return parsed.map((entry, index) => validateEntry(entry, index));
}

/**
 * Loads the app's bundled registry (spec §4.2). Fetching a fresher copy
 * from a hosted URL, with this as the offline fallback, is deferred to a
 * later phase (see spec §9) — v1 only ships the bundled copy.
 */
export function loadBundledRegistry(): Promise<ModelEntry[]> {
  return loadRegistryFromPath(path.join(__dirname, "models.json"));
}
