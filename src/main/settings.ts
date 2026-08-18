import * as fs from "fs/promises";
import { TaskType } from "./registry/types";

export interface AppSettings {
  defaultModelByTask: Partial<Record<TaskType, string>>;
}

function emptySettings(): AppSettings {
  return { defaultModelByTask: {} };
}

function isValidSettings(value: unknown): value is AppSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.defaultModelByTask === "object" && candidate.defaultModelByTask !== null;
}

/**
 * Persists the user's "set as default" choices (spec §4.2) — independent
 * of the registry's own quality_tier-based recommendation, per task.
 * Corrupt or missing settings fall back to defaults rather than failing;
 * losing this file just means the registry's computed default wins again,
 * not a functional break.
 */
export class SettingsStore {
  private constructor(
    private readonly filePath: string,
    private settings: AppSettings
  ) {}

  static async load(filePath: string): Promise<SettingsStore> {
    let settings: AppSettings;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      settings = isValidSettings(parsed) ? parsed : emptySettings();
    } catch {
      settings = emptySettings();
    }
    return new SettingsStore(filePath, settings);
  }

  getDefaultModelId(task: TaskType): string | undefined {
    return this.settings.defaultModelByTask[task];
  }

  async setDefaultModelId(task: TaskType, modelId: string): Promise<void> {
    this.settings.defaultModelByTask[task] = modelId;
    await fs.writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf-8");
  }
}
