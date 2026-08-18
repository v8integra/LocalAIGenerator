import { HardwareProfile } from "../hardware/detectHardware";
import { ModelEntry, TaskType } from "./types";

export interface ModelSelection {
  default: ModelEntry | null;
  alternates: ModelEntry[];
}

/**
 * Entries for the given task that the current hardware profile can run,
 * sorted best-first by quality_tier (spec §4.2 steps 1-2).
 */
export function getCompatibleModels(entries: ModelEntry[], task: TaskType, profile: HardwareProfile): ModelEntry[] {
  return entries
    .filter((entry) => entry.task === task)
    .filter((entry) => entry.min_vram_gb <= profile.vram_gb)
    .filter((entry) => entry.os_support.includes(profile.os))
    .sort((a, b) => b.quality_tier - a.quality_tier);
}

/**
 * Default-selection logic from spec §4.2: the top compatible entry becomes
 * the default, the rest populate the dropdown as alternates.
 */
export function selectModelForTask(entries: ModelEntry[], task: TaskType, profile: HardwareProfile): ModelSelection {
  const [defaultModel = null, ...alternates] = getCompatibleModels(entries, task, profile);
  return { default: defaultModel, alternates };
}
