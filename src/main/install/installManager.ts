import * as fs from "fs/promises";
import { ModelEntry } from "../registry/types";
import { componentFilePath, modelFilePath } from "../registry/modelPaths";
import { downloadFile, DownloadProgress } from "./downloadFile";
import { verifyChecksum } from "./verifyChecksum";
import { createVenv, installDependencies, venvExists } from "./venvManager";

export type InstallPhase =
  // Engine setup phases (spec §3: ComfyUI/audio engine, shared across all
  // models on that engine) — run at most once per engine, ahead of the
  // per-model phases below. See Orchestrator.ensureEngineInstalled().
  | "cloning-source"
  | "installing-custom-nodes"
  | "configuring-model-paths"
  | "installing-torch"
  | "installing-requirements"
  // Per-model phases.
  | "downloading"
  | "verifying"
  | "creating-venv"
  | "installing-dependencies"
  | "smoke-testing"
  | "ready"
  | "failed";

export interface InstallEvent {
  phase: InstallPhase;
  detail?: string;
  downloadProgress?: DownloadProgress;
}

export type InstallProgressCallback = (event: InstallEvent) => void;

export interface InstallOptions {
  /** Directory model weight files are placed in — their "expected folder" (spec §4.3). */
  modelsDir: string;
  /** Venv directory, shared across models on the same engine (spec §3). */
  venvDir: string;
  /** Pinned dependency versions for this engine, e.g. ["torch==2.3.0", ...]. */
  pinnedDependencies: string[];
  /**
   * Confirms the install actually works before the model is marked ready
   * (spec §4.3) — should throw on failure. The real image-generation
   * smoke test gets wired in once the ComfyUI subprocess wrapper exists
   * (build order step 5); callers can pass a lighter check until then.
   */
  smokeTest: (venvPath: string, modelPath: string) => Promise<void>;
  onProgress?: InstallProgressCallback;
}

export interface InstallResult {
  modelPath: string;
  venvPath: string;
}

const MAX_DOWNLOAD_ATTEMPTS = 2;

/** Runs the full per-model install pipeline from spec §4.3. */
export async function installModel(entry: ModelEntry, options: InstallOptions): Promise<InstallResult> {
  const emit = (phase: InstallPhase, detail?: string, downloadProgress?: DownloadProgress) =>
    options.onProgress?.({ phase, detail, downloadProgress });

  const modelPath = modelFilePath(options.modelsDir, entry);

  try {
    await downloadWithChecksumRetry(entry.id, entry.download_url, entry.checksum, modelPath, emit);

    // Components are shared between entries by filename (see ModelComponent),
    // so one that another entry already downloaded is reused as-is — a
    // failed checksum deletes the file, so whatever is left passed it.
    for (const component of entry.components ?? []) {
      const componentPath = componentFilePath(options.modelsDir, component);
      if (await fileExists(componentPath)) continue;
      await downloadWithChecksumRetry(entry.id, component.download_url, component.checksum, componentPath, emit);
    }

    emit("creating-venv");
    if (!(await venvExists(options.venvDir))) {
      await createVenv(options.venvDir);
    }

    emit("installing-dependencies");
    await installDependencies(options.venvDir, options.pinnedDependencies);

    emit("smoke-testing");
    try {
      await options.smokeTest(options.venvDir, modelPath);
    } catch (err) {
      throw new Error(`Smoke test failed for model "${entry.id}": ${(err as Error).message}`);
    }

    emit("ready");
    return { modelPath, venvPath: options.venvDir };
  } catch (err) {
    emit("failed", (err as Error).message);
    throw err;
  }
}

async function downloadWithChecksumRetry(
  modelId: string,
  url: string,
  checksum: string,
  destPath: string,
  emit: (phase: InstallPhase, detail?: string, downloadProgress?: DownloadProgress) => void
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    emit("downloading");
    await downloadFile(url, destPath, (progress) => emit("downloading", undefined, progress));

    emit("verifying");
    const isValid = await verifyChecksum(destPath, checksum);
    if (isValid) return;

    await fs.rm(destPath, { force: true });
    await fs.rm(`${destPath}.part`, { force: true });

    if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
      throw new Error(
        `Checksum verification failed ${MAX_DOWNLOAD_ATTEMPTS} times for model "${modelId}" — aborting install.`
      );
    }
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
