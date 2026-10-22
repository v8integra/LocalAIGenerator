import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { createVenv, runPip, venvExists } from "../install/venvManager";

const execFileAsync = promisify(execFile);

export type EngineSetupPhase =
  | "cloning-source"
  | "installing-custom-nodes"
  | "configuring-model-paths"
  | "creating-venv"
  | "installing-torch"
  | "installing-requirements"
  | "ready"
  | "failed";

export interface EngineSetupEvent {
  phase: EngineSetupPhase;
  detail?: string;
}

export interface EngineSetupOptions {
  /** Where ComfyUI's source ends up — orchestrator checks for <engineDir>/main.py to know the engine is installed. */
  engineDir: string;
  /** Venv the engine's Python dependencies get installed into. */
  venvDir: string;
  /** Our flat model weights directory — pointed at directly via extra_model_paths.yaml, no file duplication. */
  modelsDir: string;
  repoUrl?: string;
  /**
   * PyTorch's CUDA wheel index. Defaults to cu130 (not the newest cu132)
   * because as of this writing torchaudio's Windows/cp313 wheels lag
   * behind torch's — cu130 is the highest index where torch, torchvision,
   * and torchaudio all have matching wheels, and is what ComfyUI's own
   * README recommends for NVIDIA installs.
   */
  torchIndexUrl?: string;
  onProgress?: (event: EngineSetupEvent) => void;
}

const DEFAULT_REPO_URL = "https://github.com/comfyanonymous/ComfyUI.git";
const DEFAULT_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cu130";
const PIP_TIMEOUT_MS = 30 * 60 * 1000;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

interface CustomNodeSpec {
  repoUrl: string;
  dirName: string;
  /** Relative to the node's own directory — not every custom node needs extra deps. */
  requirementsFile?: string;
}

/**
 * Text-to-video (AnimateDiff Lightning) needs these two ComfyUI custom
 * node packages — neither ships with core ComfyUI. Kosinkadink/
 * ComfyUI-AnimateDiff-Evolved has no requirements.txt of its own (it only
 * needs what ComfyUI core already installs); VideoHelperSuite needs
 * opencv-python + imageio-ffmpeg to assemble frames into a video file.
 */
const CUSTOM_NODES: CustomNodeSpec[] = [
  { repoUrl: "https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved.git", dirName: "ComfyUI-AnimateDiff-Evolved" },
  {
    repoUrl: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git",
    dirName: "ComfyUI-VideoHelperSuite",
    requirementsFile: "requirements.txt"
  }
];

/** Sets up a real, working ComfyUI engine: source, custom nodes, venv, and dependencies (spec §3/§4.4). */
export async function setupComfyEngine(options: EngineSetupOptions): Promise<void> {
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
  const torchIndexUrl = options.torchIndexUrl ?? DEFAULT_TORCH_INDEX_URL;
  const emit = (phase: EngineSetupPhase, detail?: string) => options.onProgress?.({ phase, detail });

  try {
    const mainPyPath = path.join(options.engineDir, "main.py");
    if (!(await fileExists(mainPyPath))) {
      emit("cloning-source");
      await fs.mkdir(path.dirname(options.engineDir), { recursive: true });
      await execFileAsync("git", ["clone", "--depth", "1", repoUrl, options.engineDir], { timeout: CLONE_TIMEOUT_MS });
    }

    emit("installing-custom-nodes");
    await ensureCustomNodesCloned(options.engineDir);

    emit("configuring-model-paths");
    await writeExtraModelPaths(options.engineDir, options.modelsDir);

    emit("creating-venv");
    if (!(await venvExists(options.venvDir))) {
      await createVenv(options.venvDir);
    }

    emit("installing-torch");
    await runPip(
      options.venvDir,
      ["install", "torch", "torchvision", "torchaudio", "--extra-index-url", torchIndexUrl],
      PIP_TIMEOUT_MS
    );

    emit("installing-requirements");
    const requirementsPath = path.join(options.engineDir, "requirements.txt");
    await runPip(options.venvDir, ["install", "-r", requirementsPath], PIP_TIMEOUT_MS);

    for (const node of CUSTOM_NODES) {
      if (!node.requirementsFile) continue;
      const reqPath = path.join(options.engineDir, "custom_nodes", node.dirName, node.requirementsFile);
      if (await fileExists(reqPath)) {
        await runPip(options.venvDir, ["install", "-r", reqPath], PIP_TIMEOUT_MS);
      }
    }

    emit("ready");
  } catch (err) {
    emit("failed", (err as Error).message);
    throw err;
  }
}

async function ensureCustomNodesCloned(engineDir: string): Promise<void> {
  const customNodesDir = path.join(engineDir, "custom_nodes");
  await fs.mkdir(customNodesDir, { recursive: true });

  for (const node of CUSTOM_NODES) {
    const nodeDir = path.join(customNodesDir, node.dirName);
    if (!(await fileExists(path.join(nodeDir, "__init__.py")))) {
      await execFileAsync("git", ["clone", "--depth", "1", node.repoUrl, nodeDir], { timeout: CLONE_TIMEOUT_MS });
    }
  }
}

export async function writeExtraModelPaths(engineDir: string, modelsDir: string): Promise<void> {
  // Forward slashes read reliably in YAML on Windows without needing to
  // escape backslashes; ComfyUI's own path handling accepts them fine.
  // animatediff_models is the folder key AnimateDiff-Evolved's node
  // scans for motion modules (confirmed in its own docs) — pointed at
  // the same flat directory as checkpoints, since our install pipeline
  // downloads everything there regardless of what kind of model it is.
  // diffusion_models/text_encoders/vae are where the split-file families'
  // UNETLoader/CLIPLoader/VAELoader nodes look (Z-Image, FLUX.2 Klein).
  const normalizedModelsDir = modelsDir.replace(/\\/g, "/");
  const yaml =
    `local_ai_studio:\n  base_path: ${normalizedModelsDir}\n  checkpoints: .\n  animatediff_models: .\n` +
    `  diffusion_models: .\n  text_encoders: .\n  vae: .\n`;
  await fs.writeFile(path.join(engineDir, "extra_model_paths.yaml"), yaml, "utf-8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (require.main === module) {
  // Matches Electron's real userData path for this app on Windows
  // (%APPDATA%\local-ai-studio) without needing the Electron runtime —
  // appPaths.ts can't be used standalone since it calls app.getPath().
  const userData = path.join(os.homedir(), "AppData", "Roaming", "local-ai-studio");
  const options: EngineSetupOptions = {
    engineDir: path.join(userData, "engines", "comfyui"),
    venvDir: path.join(userData, "venvs", "comfyui"),
    modelsDir: path.join(userData, "models"),
    onProgress: (event) => {
      console.log(`[${event.phase}]${event.detail ? " " + event.detail : ""}`);
    }
  };

  setupComfyEngine(options)
    .then(() => {
      console.log("ComfyUI engine setup complete.");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
