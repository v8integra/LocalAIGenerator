import * as fs from "fs/promises";
import * as path from "path";
import { ModelEntry } from "./types";

/** Registry entries not yet backed by a real download (still "TODO") aren't installable. */
export function hasRealDownload(entry: ModelEntry): boolean {
  return entry.download_url !== "TODO" && entry.checksum !== "TODO";
}

/** Where a model's weights land in the models directory — its "expected folder" (spec §4.3). */
export function modelFilePath(modelsDir: string, entry: ModelEntry): string {
  const ext = hasRealDownload(entry) ? path.extname(new URL(entry.download_url).pathname) : "";
  return path.join(modelsDir, `${entry.id}${ext}`);
}

export async function isModelInstalled(modelsDir: string, entry: ModelEntry): Promise<boolean> {
  if (!hasRealDownload(entry)) return false;
  try {
    const stat = await fs.stat(modelFilePath(modelsDir, entry));
    return stat.size > 0;
  } catch {
    return false;
  }
}
