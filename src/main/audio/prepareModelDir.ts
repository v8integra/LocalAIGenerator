import * as fs from "fs/promises";
import * as path from "path";
import { downloadFile } from "../install/downloadFile";

/**
 * transformers' from_pretrained() needs these alongside the weights file
 * to load a model — confirmed present in both facebook/musicgen-medium
 * and facebook/musicgen-small's Hugging Face repos.
 */
const COMPANION_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "special_tokens_map.json",
  "spiece.model",
  "tokenizer.json",
  "tokenizer_config.json"
];

export interface HfRepoFile {
  repoId: string;
  filename: string;
}

/** Parses e.g. https://huggingface.co/facebook/musicgen-small/resolve/main/model.safetensors */
export function parseHfRepoAndFilename(downloadUrl: string): HfRepoFile {
  const url = new URL(downloadUrl);
  const match = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
  if (!match) {
    throw new Error(`Could not parse a Hugging Face repo and filename from "${downloadUrl}"`);
  }
  return { repoId: match[1], filename: decodeURIComponent(match[2]) };
}

/**
 * Assembles a directory transformers' from_pretrained() can load directly:
 * the already-downloaded weights file (hard-linked under its original HF
 * filename, not copied, so multi-GB files aren't duplicated on disk) plus
 * the small companion config/tokenizer files, fetched fresh via our own
 * resumable downloader rather than delegating to transformers' own cache.
 */
export async function prepareModelDir(weightsFilePath: string, downloadUrl: string, targetDir: string): Promise<void> {
  const { repoId, filename } = parseHfRepoAndFilename(downloadUrl);

  await fs.mkdir(targetDir, { recursive: true });
  await linkOrCopy(weightsFilePath, path.join(targetDir, filename));

  for (const companionFile of COMPANION_FILES) {
    const dest = path.join(targetDir, companionFile);
    if (await fileExists(dest)) continue;
    await downloadFile(`https://huggingface.co/${repoId}/resolve/main/${companionFile}`, dest);
  }
}

async function linkOrCopy(src: string, dest: string): Promise<void> {
  if (await fileExists(dest)) return;
  try {
    await fs.link(src, dest);
  } catch {
    // Cross-volume or filesystem that doesn't support hard links.
    await fs.copyFile(src, dest);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
