import * as fs from "fs/promises";
import * as path from "path";
import { ComponentRole, ModelComponent, ModelEntry } from "./types";

/** Registry entries not yet backed by a real download (still "TODO") aren't installable. */
export function hasRealDownload(entry: ModelEntry): boolean {
  return entry.download_url !== "TODO" && entry.checksum !== "TODO";
}

/** Where a model's weights land in the models directory — its "expected folder" (spec §4.3). */
export function modelFilePath(modelsDir: string, entry: ModelEntry): string {
  const ext = hasRealDownload(entry) ? path.extname(new URL(entry.download_url).pathname) : "";
  return path.join(modelsDir, `${entry.id}${ext}`);
}

/** Shared components keep their original filename, so two entries pointing at the same URL resolve to one file. */
export function componentFilePath(modelsDir: string, component: ModelComponent): string {
  return path.join(modelsDir, path.basename(decodeURIComponent(new URL(component.download_url).pathname)));
}

/** The filename ComfyUI's loader node should reference for an entry's component of the given role. */
export function componentFilename(entry: ModelEntry, role: ComponentRole): string {
  const component = entry.components?.find((c) => c.role === role);
  if (!component) throw new Error(`Model "${entry.id}" has no ${role} component configured`);
  return path.basename(componentFilePath("", component));
}

export async function isModelInstalled(modelsDir: string, entry: ModelEntry): Promise<boolean> {
  if (!hasRealDownload(entry)) return false;
  const paths = [modelFilePath(modelsDir, entry), ...(entry.components ?? []).map((c) => componentFilePath(modelsDir, c))];
  for (const filePath of paths) {
    if (!(await nonEmptyFileExists(filePath))) return false;
  }
  return true;
}

async function nonEmptyFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}
