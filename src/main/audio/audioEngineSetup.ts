import * as os from "os";
import * as path from "path";
import { createVenv, runPip, venvExists } from "../install/venvManager";

export type AudioEngineSetupPhase = "creating-venv" | "installing-torch" | "installing-requirements" | "ready" | "failed";

export interface AudioEngineSetupEvent {
  phase: AudioEngineSetupPhase;
  detail?: string;
}

export interface AudioEngineSetupOptions {
  venvDir: string;
  /** See engineSetup.ts for why cu130 rather than the newest cu132 index. */
  torchIndexUrl?: string;
  onProgress?: (event: AudioEngineSetupEvent) => void;
}

const DEFAULT_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cu130";
const PIP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Sets up the venv for the "python" engine — MusicGen's own isolated
 * environment, separate from ComfyUI's (spec §3: an isolated venv per
 * engine). No source to clone here; musicgen_server.py ships bundled with
 * the app itself.
 */
export async function setupAudioEngine(options: AudioEngineSetupOptions): Promise<void> {
  const torchIndexUrl = options.torchIndexUrl ?? DEFAULT_TORCH_INDEX_URL;
  const emit = (phase: AudioEngineSetupPhase, detail?: string) => options.onProgress?.({ phase, detail });

  try {
    emit("creating-venv");
    if (!(await venvExists(options.venvDir))) {
      await createVenv(options.venvDir);
    }

    emit("installing-torch");
    await runPip(options.venvDir, ["install", "torch", "--extra-index-url", torchIndexUrl], PIP_TIMEOUT_MS);

    emit("installing-requirements");
    await runPip(options.venvDir, ["install", "transformers>=4.50.3", "numpy", "sentencepiece"], PIP_TIMEOUT_MS);

    emit("ready");
  } catch (err) {
    emit("failed", (err as Error).message);
    throw err;
  }
}

if (require.main === module) {
  // Matches Electron's real userData path for this app on Windows, same as engineSetup.ts's standalone entry point.
  const userData = path.join(os.homedir(), "AppData", "Roaming", "local-ai-studio");
  const options: AudioEngineSetupOptions = {
    venvDir: path.join(userData, "venvs", "python"),
    onProgress: (event) => {
      console.log(`[${event.phase}]${event.detail ? " " + event.detail : ""}`);
    }
  };

  setupAudioEngine(options)
    .then(() => {
      console.log("Audio engine setup complete.");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
