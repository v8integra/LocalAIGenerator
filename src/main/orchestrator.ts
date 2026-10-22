import * as fs from "fs/promises";
import * as path from "path";
import type { AppPaths } from "./appPaths";
import { HardwareProfile } from "./hardware/detectHardware";
import { InstallEvent, installModel } from "./install/installManager";
import { packagesImportable, pythonBinPath, venvExists } from "./install/venvManager";
import { componentFilename, hasRealDownload, isModelInstalled, modelFilePath } from "./registry/modelPaths";
import { ModelSelection, selectModelForTask } from "./registry/selectModel";
import { ModelEntry, TaskType } from "./registry/types";
import { SettingsStore } from "./settings";
import { AudioEngineSetupOptions, setupAudioEngine } from "./audio/audioEngineSetup";
import { GenerateMusicResult, TextToMusicInputs, generateMusic } from "./audio/generateMusic";
import { prepareModelDir } from "./audio/prepareModelDir";
import { ComfyProcessHandle, startComfyProcess } from "./comfyui/comfyProcess";
import { EngineSetupOptions, setupComfyEngine, writeExtraModelPaths } from "./comfyui/engineSetup";
import { GenerateResult, ImageToImageInputs, TextToImageInputs, TextToVideoInputs, generate } from "./comfyui/generate";
import { stageInputImage } from "./comfyui/stageInputImage";

export interface ModelOption extends ModelEntry {
  installed: boolean;
  /** False for registry entries that don't have a real download configured yet ("TODO" placeholders). */
  downloadAvailable: boolean;
}

export interface TaskModelSelection {
  default: ModelOption | null;
  alternates: ModelOption[];
}

export interface OrchestratorOptions {
  paths: AppPaths;
  /** Already-detected hardware profile and loaded registry (spec §4.1/§4.2) — acquiring them is the caller's job. */
  profile: HardwareProfile;
  registry: ModelEntry[];
  settings: SettingsStore;
  comfyPort?: number;
  /** Overridable for testing — production default launches `<venv>/Scripts/python.exe main.py --port <port>`. */
  resolveComfyLaunchCommand?: (venvDir: string, mainPyPath: string, port: number) => { command: string; args: string[] };
  audioPort?: number;
  /** Overridable for testing — production default launches `<venv>/Scripts/python.exe musicgen_server.py <modelDir> <port>`. */
  resolveAudioLaunchCommand?: (venvDir: string, modelDir: string, port: number) => { command: string; args: string[] };
  /** Overridable for testing — production default is the real setupComfyEngine (clones ComfyUI, installs torch/CUDA). */
  setupComfyEngine?: (options: EngineSetupOptions) => Promise<void>;
  /** Overridable for testing — production default is the real setupAudioEngine (installs torch/CUDA into the audio venv). */
  setupAudioEngine?: (options: AudioEngineSetupOptions) => Promise<void>;
  /** Overridable for testing — production default actually runs `python -c "import <pkg>"` in the venv, which needs a real interpreter, not a stand-in file. */
  packagesImportable?: (venvDir: string, packages: string[]) => Promise<boolean>;
}

const DEFAULT_COMFY_PORT = 8188;
const DEFAULT_AUDIO_PORT = 8189;
/**
 * AnimateDiff Lightning isn't self-contained like SDXL Turbo — it's a
 * motion module that patches a base SD checkpoint. The registry schema
 * has no concept of one model depending on another, so rather than
 * redesign it for this one case, the pairing is hardcoded for v1.
 */
const VIDEO_BASE_CHECKPOINT_ID = "sd15";

/**
 * Central main-process state: model selection, install triggering, and
 * generation — the single place the IPC layer talks to. Takes the
 * hardware profile and registry as already-acquired inputs, so it's pure
 * orchestration logic, testable without touching real hardware or disk.
 */
export class Orchestrator {
  private readonly profile: HardwareProfile;
  private readonly registry: ModelEntry[];
  private readonly settings: SettingsStore;
  private comfyHandle: ComfyProcessHandle | null = null;
  private comfyHandleCheckpointFilename: string | null = null;
  private readonly comfyPort: number;
  private readonly resolveComfyLaunchCommand: NonNullable<OrchestratorOptions["resolveComfyLaunchCommand"]>;
  private audioHandle: ComfyProcessHandle | null = null;
  private audioHandleModelId: string | null = null;
  private readonly audioPort: number;
  private readonly resolveAudioLaunchCommand: NonNullable<OrchestratorOptions["resolveAudioLaunchCommand"]>;
  private readonly setupComfyEngineFn: NonNullable<OrchestratorOptions["setupComfyEngine"]>;
  private readonly setupAudioEngineFn: NonNullable<OrchestratorOptions["setupAudioEngine"]>;
  private readonly packagesImportableFn: NonNullable<OrchestratorOptions["packagesImportable"]>;
  /**
   * Switching tasks away from and back to an in-progress install (or two
   * different tasks that happen to share an engine) used to call
   * installModelById()/setupComfyEngine() a second time concurrently —
   * two real downloads or pip installs racing on the same destination file
   * caused visibly jumping progress and, on Windows, an EPERM rename error
   * when both finished around the same time. These maps make repeat calls
   * for the same model/engine join the one real operation instead.
   */
  private readonly inFlightInstalls = new Map<string, Promise<void>>();
  private readonly installSubscribers = new Map<string, Set<(event: InstallEvent) => void>>();
  private readonly lastInstallEvent = new Map<string, InstallEvent>();
  private readonly inFlightEngineSetups = new Map<string, Promise<void>>();

  constructor(private readonly options: OrchestratorOptions) {
    this.profile = options.profile;
    this.registry = options.registry;
    this.settings = options.settings;
    this.comfyPort = options.comfyPort ?? DEFAULT_COMFY_PORT;
    this.resolveComfyLaunchCommand =
      options.resolveComfyLaunchCommand ??
      ((venvDir, mainPyPath, port) => ({
        command: pythonBinPath(venvDir),
        args: [mainPyPath, "--port", String(port)]
      }));
    this.audioPort = options.audioPort ?? DEFAULT_AUDIO_PORT;
    this.resolveAudioLaunchCommand =
      options.resolveAudioLaunchCommand ??
      ((venvDir, modelDir, port) => ({
        command: pythonBinPath(venvDir),
        args: [path.join(__dirname, "audio", "musicgen_server.py"), modelDir, String(port)]
      }));
    this.setupComfyEngineFn = options.setupComfyEngine ?? setupComfyEngine;
    this.setupAudioEngineFn = options.setupAudioEngine ?? setupAudioEngine;
    this.packagesImportableFn = options.packagesImportable ?? packagesImportable;
  }

  getHardwareProfile(): HardwareProfile {
    return this.profile;
  }

  async getModelSelection(taskType: TaskType): Promise<TaskModelSelection> {
    const computed = selectModelForTask(this.registry, taskType, this.profile);
    const selection = this.applyDefaultOverride(computed, this.settings.getDefaultModelId(taskType));
    return {
      default: selection.default ? await this.toOption(selection.default) : null,
      alternates: await Promise.all(selection.alternates.map((entry) => this.toOption(entry)))
    };
  }

  /**
   * Applies a persisted "set as default" choice (spec §4.2) on top of the
   * registry's own quality_tier-based pick. If the override model isn't
   * among the currently compatible entries (e.g. hardware changed, or it
   * was removed from the registry), falls back to the computed default
   * rather than erroring — a stale override should never break the task.
   */
  private applyDefaultOverride(selection: ModelSelection, overrideId: string | undefined): ModelSelection {
    if (!overrideId) return selection;

    const all = selection.default ? [selection.default, ...selection.alternates] : selection.alternates;
    const overrideIndex = all.findIndex((entry) => entry.id === overrideId);
    if (overrideIndex === -1) return selection;

    const newDefault = all[overrideIndex];
    const newAlternates = all.filter((_, index) => index !== overrideIndex);
    return { default: newDefault, alternates: newAlternates };
  }

  /** Persists the user's choice of default model for a task (spec §4.2), independent of the registry's own pick. */
  async setDefaultModel(taskType: TaskType, modelId: string): Promise<void> {
    const entry = this.findEntry(modelId);
    if (entry.task !== taskType) {
      throw new Error(`Model "${modelId}" is not a ${taskType} model`);
    }
    await this.settings.setDefaultModelId(taskType, modelId);
  }

  private async toOption(entry: ModelEntry): Promise<ModelOption> {
    const downloadAvailable = hasRealDownload(entry);
    const installed = downloadAvailable && (await isModelInstalled(this.options.paths.modelsDir, entry));
    return { ...entry, installed, downloadAvailable };
  }

  /**
   * Installs a model, first setting up its engine (ComfyUI/torch, or the
   * audio venv) if that hasn't happened yet — the app is meant to be fully
   * usable right after the installer finishes, with no separate "engine
   * setup" step for the user to know to run (spec §6's first-run flow).
   * Concurrent calls for the same modelId join the one real operation
   * instead of starting a second one (see the inFlight* maps' comment).
   */
  async installModelById(modelId: string, onProgress?: (event: InstallEvent) => void): Promise<void> {
    const entry = this.findEntry(modelId);
    if (!hasRealDownload(entry)) {
      throw new Error(`Model "${modelId}" doesn't have a download configured yet`);
    }

    let promise = this.inFlightInstalls.get(modelId);
    if (!promise) {
      const subscribers = new Set<(event: InstallEvent) => void>();
      this.installSubscribers.set(modelId, subscribers);

      promise = this.runInstall(entry, modelId, subscribers).finally(() => {
        this.inFlightInstalls.delete(modelId);
        this.installSubscribers.delete(modelId);
        this.lastInstallEvent.delete(modelId);
      });
      this.inFlightInstalls.set(modelId, promise);
    }

    const subscribers = this.installSubscribers.get(modelId);
    if (onProgress) {
      subscribers?.add(onProgress);
      // A caller joining an install already in progress (e.g. the user
      // switched tasks and back) needs the current state immediately, not
      // a blank slate until the next event — otherwise the progress bar
      // visibly resets on every re-attach.
      const lastEvent = this.lastInstallEvent.get(modelId);
      if (lastEvent) onProgress(lastEvent);
    }

    try {
      await promise;
    } finally {
      if (onProgress) subscribers?.delete(onProgress);
    }
  }

  private async runInstall(
    entry: ModelEntry,
    modelId: string,
    subscribers: Set<(event: InstallEvent) => void>
  ): Promise<void> {
    const onProgress = (event: InstallEvent) => {
      this.lastInstallEvent.set(modelId, event);
      for (const cb of subscribers) cb(event);
    };

    await this.ensureEngineInstalled(entry.engine, onProgress);

    // AnimateDiff motion modules (this entry) patch a separate base SD
    // checkpoint at generation time (see VIDEO_BASE_CHECKPOINT_ID) rather
    // than being self-contained — installing only the motion module left a
    // real gap on a genuinely fresh install: selecting Text to Video only
    // ever installed e.g. animatediff-lightning, never sd15, so generation
    // hard-failed with "needs sd15 installed first" until the user
    // separately visited Text to Image. Installing both together here
    // matches how they're actually used.
    if (entry.task === "text-to-video") {
      const checkpointEntry = this.findEntry(VIDEO_BASE_CHECKPOINT_ID);
      if (!(await isModelInstalled(this.options.paths.modelsDir, checkpointEntry))) {
        await this.installModelById(VIDEO_BASE_CHECKPOINT_ID, onProgress);
      }
    }

    await installModel(entry, {
      modelsDir: this.options.paths.modelsDir,
      venvDir: path.join(this.options.paths.venvsDir, entry.engine),
      // No engine-specific dependencies installed here — ensureEngineInstalled
      // above handles the engine itself (ComfyUI/torch, or the audio venv),
      // once per engine rather than once per model.
      pinnedDependencies: [],
      smokeTest: async (_venvPath, modelPath) => {
        const stat = await fs.stat(modelPath);
        if (stat.size === 0) throw new Error("Downloaded file is empty");
      },
      onProgress
    });

    // transformers' from_pretrained() needs a whole directory (config,
    // tokenizer files, weights under their original filename), not just
    // the single weights file our download pipeline fetches — assemble it
    // once here rather than on every generate() call.
    if (entry.engine === "python") {
      const weightsPath = modelFilePath(this.options.paths.modelsDir, entry);
      await prepareModelDir(weightsPath, entry.download_url, this.audioModelDirFor(modelId));
    }
  }

  /**
   * Idempotent: does nothing once the engine is already set up. Dedups
   * concurrent setup of the same engine across different models.
   *
   * The in-flight map is checked and populated synchronously, before any
   * `await` — the "is it already installed" disk check happens inside the
   * deduped operation itself (runEngineSetup), not before it. If the disk
   * check ran first here, two concurrent callers could both read "not
   * installed yet" (each on their own tick) before either had registered
   * an in-flight promise, and both would kick off a real setup — the same
   * race this whole map exists to prevent, just one level up.
   */
  private async ensureEngineInstalled(engine: ModelEntry["engine"], onProgress?: (event: InstallEvent) => void): Promise<void> {
    let setupPromise = this.inFlightEngineSetups.get(engine);
    if (!setupPromise) {
      setupPromise = this.runEngineSetup(engine, onProgress).finally(() => this.inFlightEngineSetups.delete(engine));
      this.inFlightEngineSetups.set(engine, setupPromise);
    }
    return setupPromise;
  }

  /**
   * Idempotent "is the engine actually usable" check + (re-)setup. Deliberately
   * verifies real package importability, not just that the venv directory or
   * main.py happen to exist — a venv can be left with python.exe in place but
   * an incomplete package set if a prior pip install was interrupted (network
   * drop, disk space, antivirus interference), and bare-existence checks would
   * then treat that broken state as "done" forever, never retrying. Found via
   * a real user report of a ModuleNotFoundError for numpy on a fresh install.
   * setupComfyEngine()/setupAudioEngine() are themselves idempotent per phase
   * (they skip venv creation if one exists, for example), so re-invoking them
   * here safely retries only whatever actually didn't finish.
   */
  private async runEngineSetup(engine: ModelEntry["engine"], onProgress?: (event: InstallEvent) => void): Promise<void> {
    const venvDir = this.venvDirFor(engine);
    const forward = (event: { phase: string; detail?: string }) =>
      onProgress?.({ phase: event.phase as InstallEvent["phase"], detail: event.detail });

    if (engine === "comfyui") {
      const engineDir = this.engineDirFor("comfyui");
      const mainPyPath = path.join(engineDir, "main.py");
      const alreadyUsable =
        (await fileExists(mainPyPath)) &&
        (await venvExists(venvDir)) &&
        (await this.packagesImportableFn(venvDir, ["torch"]));
      if (alreadyUsable) return;

      await this.setupComfyEngineFn({
        engineDir,
        venvDir,
        modelsDir: this.options.paths.modelsDir,
        onProgress: forward
      });
      return;
    }

    if (engine === "python") {
      const alreadyUsable =
        (await venvExists(venvDir)) &&
        (await this.packagesImportableFn(venvDir, ["numpy", "transformers", "sentencepiece"]));
      if (alreadyUsable) return;

      await this.setupAudioEngineFn({ venvDir, onProgress: forward });
    }
  }

  private audioModelDirFor(modelId: string): string {
    return path.join(this.options.paths.modelsDir, `${modelId}-hf`);
  }

  private findEntry(modelId: string): ModelEntry {
    const entry = this.registry.find((e) => e.id === modelId);
    if (!entry) throw new Error(`Unknown model "${modelId}"`);
    return entry;
  }

  private engineDirFor(engine: string): string {
    return path.join(this.options.paths.enginesDir, engine);
  }

  private venvDirFor(engine: string): string {
    return path.join(this.options.paths.venvsDir, engine);
  }

  /**
   * Starts the ComfyUI subprocess on first use and keeps it warm across
   * calls that reuse the same checkpoint (spec §4.4). installModelById()
   * sets the engine up automatically, so the "isn't installed yet" error
   * below should never fire in normal use — it's a defensive check, not
   * the expected first-run path.
   *
   * Restarts the process whenever the checkpoint changes, rather than
   * relying on ComfyUI to swap checkpoints within one process (which is
   * its normal, intended usage). On an 8GB card, repeatedly loading and
   * offloading very different checkpoints (SDXL's ~7GB alongside SD1.5's
   * ~2-4GB) in one long-running process was observed to eventually
   * produce corrupted, blurry, incoherent output on *later* generations —
   * even ones using an already-proven-good checkpoint — that a fresh
   * process immediately fixed. Matches ensureAudioRunning()'s existing
   * restart-on-model-switch pattern; a full process kill is also the only
   * way to *guarantee* CUDA memory is actually released, regardless of
   * whether ComfyUI's own in-process cleanup has bugs.
   */
  private async ensureComfyRunning(checkpointFilename: string): Promise<string> {
    if (this.comfyHandle && this.comfyHandleCheckpointFilename === checkpointFilename) {
      return `http://127.0.0.1:${this.comfyHandle.port}/`;
    }

    if (this.comfyHandle) {
      await this.comfyHandle.kill();
      this.comfyHandle = null;
      this.comfyHandleCheckpointFilename = null;
    }

    const engineDir = this.engineDirFor("comfyui");
    const venvDir = this.venvDirFor("comfyui");
    const mainPyPath = path.join(engineDir, "main.py");

    const engineInstalled = await fileExists(mainPyPath);
    if (!engineInstalled) {
      throw new Error(
        "The ComfyUI engine isn't installed yet. Try installing a model for this task from the dropdown first."
      );
    }

    // Rewritten on every launch, not just at engine setup, so engines set up
    // before a new model folder key was added (e.g. diffusion_models for the
    // split-file families) pick it up without a reinstall.
    await writeExtraModelPaths(engineDir, this.options.paths.modelsDir);

    const { command, args } = this.resolveComfyLaunchCommand(venvDir, mainPyPath, this.comfyPort);
    // A cold first launch (custom nodes importing, nothing in the disk cache
    // yet) was seen to overrun the 30s default on a real 8GB machine — the
    // very first Z-Image generation failed with a startup timeout, then
    // worked on retry.
    this.comfyHandle = await startComfyProcess({
      command,
      args,
      cwd: engineDir,
      port: this.comfyPort,
      readyTimeoutMs: 120000
    });
    this.comfyHandleCheckpointFilename = checkpointFilename;
    return `http://127.0.0.1:${this.comfyPort}/`;
  }

  async generateImage(modelId: string, inputs: TextToImageInputs): Promise<GenerateResult> {
    let entry: ModelEntry;
    try {
      entry = this.findEntry(modelId);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    const checkpointFilename = path.basename(modelFilePath(this.options.paths.modelsDir, entry));

    let comfyBaseUrl: string;
    try {
      comfyBaseUrl = await this.ensureComfyRunning(checkpointFilename);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    return generate("text-to-image", modelId, { ...samplingPresetInputs(entry), ...inputs }, {
      comfyBaseUrl,
      resolveCheckpointFilename: () => checkpointFilename,
      workflow: entry.workflow,
      resolveComponentFilename: (role) => componentFilename(entry, role),
      outputDir: this.options.paths.tempDir
    });
  }

  async generateVideo(modelId: string, inputs: TextToVideoInputs): Promise<GenerateResult> {
    let motionEntry: ModelEntry;
    let checkpointEntry: ModelEntry;
    try {
      motionEntry = this.findEntry(modelId);
      checkpointEntry = this.findEntry(VIDEO_BASE_CHECKPOINT_ID);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    if (!(await isModelInstalled(this.options.paths.modelsDir, checkpointEntry))) {
      return {
        status: "error",
        error:
          `Text-to-video needs the "${checkpointEntry.label}" base checkpoint installed first — ` +
          `install it from the Text to Image task's model dropdown, then try again.`
      };
    }

    const checkpointFilename = path.basename(modelFilePath(this.options.paths.modelsDir, checkpointEntry));

    let comfyBaseUrl: string;
    try {
      comfyBaseUrl = await this.ensureComfyRunning(checkpointFilename);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    // The motion module's own distillation status determines sampling needs
    // (Lightning's 4-step/cfg~1.5 vs v2's standard 20-step/cfg~7), not the
    // shared sd15 checkpoint's — so the preset comes from motionEntry.
    return generate("text-to-video", modelId, { ...samplingPresetInputs(motionEntry), ...inputs }, {
      comfyBaseUrl,
      resolveCheckpointFilename: () => checkpointFilename,
      resolveMotionModelFilename: () => path.basename(modelFilePath(this.options.paths.modelsDir, motionEntry)),
      outputDir: this.options.paths.tempDir
    });
  }

  async generateImageToImage(modelId: string, inputs: ImageToImageInputs): Promise<GenerateResult> {
    let entry: ModelEntry;
    try {
      entry = this.findEntry(modelId);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    const checkpointFilename = path.basename(modelFilePath(this.options.paths.modelsDir, entry));

    let comfyBaseUrl: string;
    try {
      comfyBaseUrl = await this.ensureComfyRunning(checkpointFilename);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    const engineDir = this.engineDirFor("comfyui");

    return generate("image-to-image", modelId, { ...samplingPresetInputs(entry), ...inputs }, {
      comfyBaseUrl,
      resolveCheckpointFilename: () => checkpointFilename,
      workflow: entry.workflow,
      resolveComponentFilename: (role) => componentFilename(entry, role),
      stageInputImage: (sourceImagePath) => stageInputImage(sourceImagePath, engineDir),
      outputDir: this.options.paths.tempDir
    });
  }

  /**
   * Starts (or restarts, on a model switch) the audio subprocess. Unlike
   * ComfyUI — which swaps checkpoints within one long-running process via
   * workflow node references — musicgen_server.py loads one model at
   * startup, so switching models means killing and relaunching it (spec
   * §4.4's "switching model" state applies here too, just at the process
   * level instead of within it).
   */
  private async ensureAudioRunning(modelId: string): Promise<string> {
    if (this.audioHandle && this.audioHandleModelId === modelId) {
      return `http://127.0.0.1:${this.audioHandle.port}/`;
    }

    if (this.audioHandle) {
      await this.audioHandle.kill();
      this.audioHandle = null;
      this.audioHandleModelId = null;
    }

    const venvDir = this.venvDirFor("python");
    if (!(await venvExists(venvDir))) {
      throw new Error(
        "The audio engine isn't installed yet. Try installing a model for this task from the dropdown first."
      );
    }

    const modelDir = this.audioModelDirFor(modelId);
    if (!(await fileExists(path.join(modelDir, "config.json")))) {
      throw new Error(`Model "${modelId}" hasn't been fully installed yet — its model directory is incomplete.`);
    }

    const { command, args } = this.resolveAudioLaunchCommand(venvDir, modelDir, this.audioPort);
    this.audioHandle = await startComfyProcess({
      command,
      args,
      cwd: this.options.paths.modelsDir,
      port: this.audioPort,
      healthCheckPath: "/health",
      // Loading MusicGen's weights onto the GPU takes longer than ComfyUI's
      // idle startup, which doesn't load a model until the first request.
      readyTimeoutMs: 120000
    });
    this.audioHandleModelId = modelId;
    return `http://127.0.0.1:${this.audioPort}/`;
  }

  async generateMusic(modelId: string, inputs: TextToMusicInputs): Promise<GenerateMusicResult> {
    let entry: ModelEntry;
    try {
      entry = this.findEntry(modelId);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    // ACE-Step runs inside ComfyUI like the image models; only MusicGen
    // needs the separate audio engine below.
    if (entry.engine === "comfyui") {
      const checkpointFilename = path.basename(modelFilePath(this.options.paths.modelsDir, entry));
      let comfyBaseUrl: string;
      try {
        comfyBaseUrl = await this.ensureComfyRunning(checkpointFilename);
      } catch (err) {
        return { status: "error", error: (err as Error).message };
      }
      return generate("text-to-music", modelId, inputs, {
        comfyBaseUrl,
        resolveCheckpointFilename: () => checkpointFilename,
        workflow: entry.workflow,
        outputDir: this.options.paths.tempDir
      });
    }

    let audioBaseUrl: string;
    try {
      audioBaseUrl = await this.ensureAudioRunning(modelId);
    } catch (err) {
      return { status: "error", error: (err as Error).message };
    }

    return generateMusic(inputs, { audioBaseUrl, outputDir: this.options.paths.tempDir });
  }

  async shutdown(): Promise<void> {
    if (this.comfyHandle) {
      await this.comfyHandle.kill();
      this.comfyHandle = null;
      this.comfyHandleCheckpointFilename = null;
    }
    if (this.audioHandle) {
      await this.audioHandle.kill();
      this.audioHandle = null;
      this.audioHandleModelId = null;
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

/**
 * Converts a registry entry's sampling_preset (if any) into the shape
 * buildTxt2ImgWorkflow/buildImg2ImgWorkflow's params expect, so it can be
 * spread as a base that real inputs (currently never sent by the renderer,
 * but future-proofed) override. Distilled/turbo models like SDXL Turbo
 * need this — buildTxt2ImgWorkflow's own generic SD1.x-style defaults
 * (steps=20, cfg=7) visibly degrade their output.
 */
export function samplingPresetInputs(entry: ModelEntry): Partial<TextToImageInputs> {
  const preset = entry.sampling_preset;
  if (!preset) return {};
  return {
    steps: preset.steps,
    cfg: preset.cfg,
    samplerName: preset.sampler_name,
    scheduler: preset.scheduler,
    width: preset.width,
    height: preset.height
  };
}
