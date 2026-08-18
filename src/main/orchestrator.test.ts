import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { AppPaths } from "./appPaths";
import { Orchestrator, samplingPresetInputs } from "./orchestrator";
import { HardwareProfile } from "./hardware/detectHardware";
import { InstallEvent } from "./install/installManager";
import { SettingsStore } from "./settings";
import { modelFilePath } from "./registry/modelPaths";
import { ModelEntry } from "./registry/types";
import { TestHttpServer } from "./install/testFixtures/httpServer";
import * as crypto from "crypto";

async function tmpPaths(): Promise<AppPaths> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "orchestrator-test-"));
  return {
    userData,
    modelsDir: path.join(userData, "models"),
    venvsDir: path.join(userData, "venvs"),
    enginesDir: path.join(userData, "engines"),
    tempDir: path.join(userData, "temp"),
    documentsOutputDir: path.join(userData, "documents", "LocalAIStudio"),
    settingsPath: path.join(userData, "settings.json")
  };
}

function tmpSettings(paths: AppPaths): Promise<SettingsStore> {
  return SettingsStore.load(paths.settingsPath);
}

function fakeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    os: "windows",
    os_version: "10.0.26200",
    gpu_vendor: "nvidia",
    gpu_model: "Test GPU",
    vram_gb: 8,
    ram_gb: 32,
    free_disk_gb: 200,
    ...overrides
  };
}

function makeEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "test-model",
    task: "text-to-image",
    label: "Test Model",
    engine: "comfyui",
    min_vram_gb: 4,
    recommended_vram_gb: 6,
    os_support: ["windows"],
    disk_gb: 1,
    content_policy: "moderate",
    download_url: "TODO",
    checksum: "TODO",
    quality_tier: 1,
    is_default_candidate: true,
    ...overrides
  };
}

test("samplingPresetInputs maps a registry sampling_preset to buildTxt2ImgWorkflow's param names", () => {
  const entry = makeEntry({
    sampling_preset: { steps: 4, cfg: 1.0, sampler_name: "euler", scheduler: "normal" }
  });

  assert.deepEqual(samplingPresetInputs(entry), {
    steps: 4,
    cfg: 1.0,
    samplerName: "euler",
    scheduler: "normal",
    width: undefined,
    height: undefined
  });
});

test("samplingPresetInputs maps a preset's width/height too, for models like SDXL Base that need non-default resolution", () => {
  const entry = makeEntry({
    sampling_preset: { steps: 25, cfg: 7, width: 1024, height: 1024 }
  });

  const result = samplingPresetInputs(entry);
  assert.equal(result.width, 1024);
  assert.equal(result.height, 1024);
});

test("samplingPresetInputs returns nothing for a model with no preset, so generic defaults apply", () => {
  const entry = makeEntry();
  assert.deepEqual(samplingPresetInputs(entry), {});
});

test("getModelSelection reports downloadAvailable=false and installed=false for TODO entries", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [makeEntry({ id: "no-download-yet", quality_tier: 3 })],
    settings: await tmpSettings(paths)
  });

  const selection = await orchestrator.getModelSelection("text-to-image");

  assert.equal(selection.default?.id, "no-download-yet");
  assert.equal(selection.default?.downloadAvailable, false);
  assert.equal(selection.default?.installed, false);
});

test("getModelSelection reports installed=true once the weight file exists on disk", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    // This test only cares about the download itself, not engine setup —
    // without an override, installModelById would attempt a real
    // `git clone`/pip install by default (see the dedicated engine-setup
    // tests below for that).
    setupComfyEngine: async () => {}
  });

  let notInstalledYet = await orchestrator.getModelSelection("text-to-image");
  assert.equal(notInstalledYet.default?.installed, false);
  assert.equal(notInstalledYet.default?.downloadAvailable, true);

  await orchestrator.installModelById("real-model", () => {});

  const nowInstalled = await orchestrator.getModelSelection("text-to-image");
  assert.equal(nowInstalled.default?.installed, true);

  await server.close();
});

test("installModelById rejects entries without a real download configured", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [makeEntry({ id: "no-download-yet" })],
    settings: await tmpSettings(paths)
  });

  await assert.rejects(() => orchestrator.installModelById("no-download-yet"), /doesn't have a download configured/);
});

test("installModelById forwards install progress events", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {}
  });

  const events: InstallEvent[] = [];
  await orchestrator.installModelById("real-model", (event) => events.push(event));

  assert.equal(events.at(-1)?.phase, "ready");

  await server.close();
});

test("installModelById sets the comfyui engine up automatically when it isn't installed yet", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  let engineSetupCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async (options) => {
      engineSetupCalls++;
      options.onProgress?.({ phase: "cloning-source" });
      options.onProgress?.({ phase: "ready" });
    }
  });

  const events: InstallEvent[] = [];
  await orchestrator.installModelById("real-model", (event) => events.push(event));

  assert.equal(engineSetupCalls, 1);
  // Engine-setup phases should reach the caller ahead of the model's own
  // download phases — the app is meant to be usable right after install,
  // with no separate "engine setup" step for the user to trigger manually.
  const cloningIndex = events.findIndex((e) => e.phase === "cloning-source");
  const downloadingIndex = events.findIndex((e) => e.phase === "downloading");
  assert.ok(cloningIndex !== -1 && downloadingIndex !== -1 && cloningIndex < downloadingIndex);

  await server.close();
});

test("installModelById skips engine setup when the comfyui engine is already fully installed", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");
  const venvDir = path.join(paths.venvsDir, "comfyui");
  await fs.mkdir(path.join(venvDir, "Scripts"), { recursive: true });
  await fs.writeFile(path.join(venvDir, "Scripts", "python.exe"), "stand-in marker file");

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  let engineSetupCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {
      engineSetupCalls++;
    },
    // The stand-in files above are text, not a real interpreter — a real
    // packagesImportable() would correctly say they're not usable. This
    // test is specifically about the venv-exists fast path, so stub the
    // package check the same way generateImage's fixture tests stub the
    // launch command instead of needing a real ComfyUI process.
    packagesImportable: async () => true
  });

  await orchestrator.installModelById("real-model", () => {});

  assert.equal(engineSetupCalls, 0, "an already-installed engine shouldn't be set up again");

  await server.close();
});

test("installModelById re-runs engine setup when the venv exists but required packages aren't actually importable", async () => {
  // Regression test for a real user report: musicgen_server.py crashed
  // with "ModuleNotFoundError: No module named 'numpy'" on a fresh
  // install. The venv existing was being treated as "fully installed"
  // forever, even if a prior pip install had been interrupted (network
  // drop, disk space, antivirus) and never actually finished — so a
  // broken venv was never retried. packagesImportable() now has to
  // actually say yes before the engine is considered usable.
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");
  const venvDir = path.join(paths.venvsDir, "comfyui");
  await fs.mkdir(path.join(venvDir, "Scripts"), { recursive: true });
  await fs.writeFile(path.join(venvDir, "Scripts", "python.exe"), "stand-in marker file");

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  let engineSetupCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {
      engineSetupCalls++;
    },
    packagesImportable: async () => false
  });

  await orchestrator.installModelById("real-model", () => {});

  assert.equal(engineSetupCalls, 1, "a venv with missing packages should be re-set-up, not treated as already installed");

  await server.close();
});

test("concurrent installModelById calls for the same model share one real download instead of racing", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const entry = makeEntry({ id: "real-model", download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {}
  });

  const eventsA: InstallEvent[] = [];
  const eventsB: InstallEvent[] = [];

  // Simulates the reported bug's trigger: the user switches back to a task
  // with an install already in flight, re-invoking installModelById for
  // the same model before the first call has finished. Without dedup this
  // raced two real downloads to the same destination file, which failed
  // with an EPERM on the final rename and showed jumping progress.
  await Promise.all([
    orchestrator.installModelById("real-model", (e) => eventsA.push(e)),
    orchestrator.installModelById("real-model", (e) => eventsB.push(e))
  ]);

  assert.equal(server.requests.length, 1, "the file should only be requested once, not raced twice");
  assert.equal(eventsA.at(-1)?.phase, "ready");
  assert.equal(eventsB.at(-1)?.phase, "ready");

  await server.close();
});

test("concurrent installModelById calls for two different models on a shared engine only set the engine up once", async () => {
  const paths = await tmpPaths();
  const bodyA = crypto.randomBytes(1024);
  const checksumA = crypto.createHash("sha256").update(bodyA).digest("hex");
  const serverA = new TestHttpServer(bodyA);
  const urlA = await serverA.listen();

  const bodyB = crypto.randomBytes(1024);
  const checksumB = crypto.createHash("sha256").update(bodyB).digest("hex");
  const serverB = new TestHttpServer(bodyB);
  const urlB = await serverB.listen();

  const entryA = makeEntry({ id: "model-a", download_url: `${urlA}a.bin`, checksum: `sha256:${checksumA}` });
  const entryB = makeEntry({ id: "model-b", download_url: `${urlB}b.bin`, checksum: `sha256:${checksumB}` });

  let engineSetupCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entryA, entryB],
    settings: await tmpSettings(paths),
    setupComfyEngine: async (options) => {
      engineSetupCalls++;
      // Real setupComfyEngine creates the venv as part of setup, which is
      // what stops installModel()'s own per-model venv check (a separate,
      // non-deduped code path — see installManager.ts) from racing when
      // two models share an engine. A fake that skips this step would hit
      // that race itself (two concurrent `python -m venv` calls against
      // the same directory), which is a test-fidelity gap, not a real bug.
      await fs.mkdir(path.join(options.venvDir, "Scripts"), { recursive: true });
      await fs.writeFile(path.join(options.venvDir, "Scripts", "python.exe"), "stand-in marker file");
      options.onProgress?.({ phase: "ready" });
    }
  });

  await Promise.all([
    orchestrator.installModelById("model-a", () => {}),
    orchestrator.installModelById("model-b", () => {})
  ]);

  assert.equal(engineSetupCalls, 1, "the shared comfyui engine should only be set up once");

  await serverA.close();
  await serverB.close();
});

test("installModelById sets the audio engine up automatically for a python-engine model", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const entry = makeEntry({
    id: "musicgen-small",
    task: "text-to-music",
    engine: "python",
    download_url: `${url}model.bin`,
    checksum: `sha256:${checksum}`
  });
  let engineSetupCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    setupAudioEngine: async (options) => {
      engineSetupCalls++;
      options.onProgress?.({ phase: "ready" });
    }
  });

  // prepareModelDir's companion-file step (run after engine setup, for
  // python-engine models — see runInstall) needs a real
  // huggingface.co/<repo>/resolve/main/<file> URL shape and hits the real
  // network for those files; this test's local fixture URL isn't shaped
  // like one, so the overall install is expected to fail past that point.
  // That's fine — all this test needs to prove is that engine setup ran
  // first, which it can assert regardless of the later failure.
  await assert.rejects(() => orchestrator.installModelById("musicgen-small", () => {}));

  assert.equal(engineSetupCalls, 1);

  await server.close();
});

test("generateImage returns a clear error when the ComfyUI engine isn't installed", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({ id: "sdxl-turbo", download_url: "https://example.com/x.safetensors", checksum: "sha256:abc" });
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [entry], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateImage("sdxl-turbo", { prompt: "a cat" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /ComfyUI engine isn't installed yet/);
  }
});

test("generateImage returns a clear error for an unknown model", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateImage("does-not-exist", { prompt: "a cat" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /Unknown model/);
  }
});

test("generateImage runs the full pipeline end to end against a fixture engine", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({ id: "sdxl-turbo", download_url: "https://example.com/x.safetensors", checksum: "sha256:abc" });

  // Stand in for a real ComfyUI install: an empty marker file so the
  // "is the engine installed" check passes, plus a launch command
  // override that spawns our fake server fixture instead of real
  // ComfyUI (which needs its own torch/CUDA venv — out of scope here).
  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");

  const fixtureScript = path.join(__dirname, "comfyui", "testFixtures", "fakeComfyServer.js");

  // startComfyProcess health-checks a concrete port, so reserve one the
  // same way comfyProcess.test.ts does rather than letting the OS pick.
  const net = await import("net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    comfyPort: port,
    resolveComfyLaunchCommand: (_venvDir, _mainPyPath, p) => ({
      command: process.execPath,
      args: [fixtureScript, `--port=${p}`]
    })
  });

  const result = await orchestrator.generateImage("sdxl-turbo", { prompt: "a cat" });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    const written = await fs.readFile(result.output_path);
    assert.ok(written.length > 0);
  }

  await orchestrator.shutdown();
});

test("ensureComfyRunning keeps the process warm across generations that use the same checkpoint", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({ id: "model-a", download_url: "https://example.com/model-a.safetensors", checksum: "sha256:abc" });

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");

  const fixtureScript = path.join(__dirname, "comfyui", "testFixtures", "fakeComfyServer.js");

  const net = await import("net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  let launchCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    comfyPort: port,
    resolveComfyLaunchCommand: (_venvDir, _mainPyPath, p) => {
      launchCalls++;
      return { command: process.execPath, args: [fixtureScript, `--port=${p}`] };
    }
  });

  const first = await orchestrator.generateImage("model-a", { prompt: "a cat" });
  const second = await orchestrator.generateImage("model-a", { prompt: "a dog" });

  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(launchCalls, 1, "the ComfyUI process should be reused, not relaunched, for the same checkpoint");

  await orchestrator.shutdown();
});

test("ensureComfyRunning restarts the ComfyUI process when the checkpoint changes", async () => {
  const paths = await tmpPaths();
  const entryA = makeEntry({ id: "model-a", download_url: "https://example.com/model-a.safetensors", checksum: "sha256:abc" });
  const entryB = makeEntry({ id: "model-b", download_url: "https://example.com/model-b.safetensors", checksum: "sha256:def" });

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");

  const fixtureScript = path.join(__dirname, "comfyui", "testFixtures", "fakeComfyServer.js");

  const net = await import("net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  let launchCalls = 0;
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entryA, entryB],
    settings: await tmpSettings(paths),
    comfyPort: port,
    resolveComfyLaunchCommand: (_venvDir, _mainPyPath, p) => {
      launchCalls++;
      return { command: process.execPath, args: [fixtureScript, `--port=${p}`] };
    }
  });

  // Regression test for a real bug: on an 8GB card, repeatedly loading
  // very different checkpoints (SDXL alongside SD1.5) within one
  // long-running ComfyUI process eventually corrupted output on *later*
  // generations, even ones reusing an already-proven-good checkpoint —
  // confirmed live by generating the same prompt on a fresh process vs.
  // a process that had already loaded several other checkpoints. A fresh
  // process every time the checkpoint changes is the fix.
  const resultA = await orchestrator.generateImage("model-a", { prompt: "a cat" });
  const resultB = await orchestrator.generateImage("model-b", { prompt: "a dog" });

  assert.equal(resultA.status, "success");
  assert.equal(resultB.status, "success");
  assert.equal(launchCalls, 2, "switching checkpoints should restart the ComfyUI process, not reuse a stale one");

  await orchestrator.shutdown();
});

test("installModelById also installs the sd15 base checkpoint when installing a text-to-video motion module", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const motionEntry = makeEntry({
    id: "animatediff-lightning",
    task: "text-to-video",
    download_url: `${url}motion.safetensors`,
    checksum: `sha256:${checksum}`
  });
  const sd15Entry = makeEntry({
    id: "sd15",
    label: "Stable Diffusion 1.5",
    download_url: `${url}sd15.safetensors`,
    checksum: `sha256:${checksum}`
  });

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [motionEntry, sd15Entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {}
  });

  await orchestrator.installModelById("animatediff-lightning", () => {});

  // Fresh install regression: selecting Text to Video used to only ever
  // install the motion module, never its sd15 dependency, so generation
  // hard-failed with "needs sd15 installed first" until the user separately
  // visited Text to Image.
  await assert.doesNotReject(() => fs.access(modelFilePath(paths.modelsDir, motionEntry)));
  await assert.doesNotReject(() => fs.access(modelFilePath(paths.modelsDir, sd15Entry)));

  await server.close();
});

test("installModelById doesn't re-download sd15 for a video model when it's already installed", async () => {
  const paths = await tmpPaths();
  const body = crypto.randomBytes(1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();

  const motionEntry = makeEntry({
    id: "animatediff-lightning",
    task: "text-to-video",
    download_url: `${url}motion.safetensors`,
    checksum: `sha256:${checksum}`
  });
  const sd15Entry = makeEntry({
    id: "sd15",
    label: "Stable Diffusion 1.5",
    download_url: `${url}sd15.safetensors`,
    checksum: `sha256:${checksum}`
  });

  await fs.mkdir(paths.modelsDir, { recursive: true });
  await fs.writeFile(modelFilePath(paths.modelsDir, sd15Entry), body);

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [motionEntry, sd15Entry],
    settings: await tmpSettings(paths),
    setupComfyEngine: async () => {}
  });

  await orchestrator.installModelById("animatediff-lightning", () => {});

  assert.equal(server.requests.length, 1, "sd15 was already installed — only the motion module's download should hit the network");

  await server.close();
});

test("generateVideo returns a clear error when the base sd15 checkpoint isn't installed", async () => {
  const paths = await tmpPaths();
  const motionEntry = makeEntry({
    id: "animatediff-lightning",
    task: "text-to-video",
    download_url: "https://example.com/motion.safetensors",
    checksum: "sha256:abc"
  });
  const sd15Entry = makeEntry({
    id: "sd15",
    label: "Stable Diffusion 1.5",
    download_url: "https://example.com/sd15.safetensors",
    checksum: "sha256:def"
  });
  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [motionEntry, sd15Entry],
    settings: await tmpSettings(paths)
  });

  const result = await orchestrator.generateVideo("animatediff-lightning", { prompt: "a cat running" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /needs the "Stable Diffusion 1\.5" base checkpoint installed first/);
  }
});

test("generateVideo returns a clear error for an unknown model", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateVideo("does-not-exist", { prompt: "a cat running" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /Unknown model/);
  }
});

test("generateVideo runs the full pipeline end to end once the base checkpoint is installed", async () => {
  const paths = await tmpPaths();
  const motionEntry = makeEntry({
    id: "animatediff-lightning",
    task: "text-to-video",
    download_url: "https://example.com/motion.safetensors",
    checksum: "sha256:abc"
  });
  const sd15Entry = makeEntry({
    id: "sd15",
    label: "Stable Diffusion 1.5",
    download_url: "https://example.com/sd15.safetensors",
    checksum: "sha256:def"
  });

  // The base checkpoint has to actually be present on disk — generateVideo
  // checks it directly, independent of which model the caller selected.
  await fs.mkdir(paths.modelsDir, { recursive: true });
  await fs.writeFile(modelFilePath(paths.modelsDir, sd15Entry), "stand-in checkpoint bytes");

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");

  const fixtureScript = path.join(__dirname, "comfyui", "testFixtures", "fakeComfyServer.js");

  const net = await import("net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [motionEntry, sd15Entry],
    settings: await tmpSettings(paths),
    comfyPort: port,
    resolveComfyLaunchCommand: (_venvDir, _mainPyPath, p) => ({
      command: process.execPath,
      args: [fixtureScript, `--port=${p}`]
    })
  });

  const result = await orchestrator.generateVideo("animatediff-lightning", { prompt: "a cat running" });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    const written = await fs.readFile(result.output_path);
    assert.ok(written.length > 0);
  }

  await orchestrator.shutdown();
});

test("generateImageToImage returns a clear error when the ComfyUI engine isn't installed", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({
    id: "sdxl-turbo-img2img",
    task: "image-to-image",
    download_url: "https://example.com/x.safetensors",
    checksum: "sha256:abc"
  });
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [entry], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateImageToImage("sdxl-turbo-img2img", {
    prompt: "a cat",
    sourceImagePath: "C:\\fake\\source.png"
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /ComfyUI engine isn't installed yet/);
  }
});

test("generateImageToImage returns a clear error for an unknown model", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateImageToImage("does-not-exist", {
    prompt: "a cat",
    sourceImagePath: "C:\\fake\\source.png"
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /Unknown model/);
  }
});

test("generateImageToImage runs the full pipeline end to end, staging a real source file into the engine's input dir", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({
    id: "sdxl-turbo-img2img",
    task: "image-to-image",
    download_url: "https://example.com/x.safetensors",
    checksum: "sha256:abc"
  });

  const engineDir = path.join(paths.enginesDir, "comfyui");
  await fs.mkdir(engineDir, { recursive: true });
  await fs.writeFile(path.join(engineDir, "main.py"), "# stand-in marker file");

  const sourceImagePath = path.join(paths.userData, "source.png");
  await fs.writeFile(sourceImagePath, "fake-source-png-bytes");

  const fixtureScript = path.join(__dirname, "comfyui", "testFixtures", "fakeComfyServer.js");

  const net = await import("net");
  const port: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entry],
    settings: await tmpSettings(paths),
    comfyPort: port,
    resolveComfyLaunchCommand: (_venvDir, _mainPyPath, p) => ({
      command: process.execPath,
      args: [fixtureScript, `--port=${p}`]
    })
  });

  const result = await orchestrator.generateImageToImage("sdxl-turbo-img2img", { prompt: "a cat", sourceImagePath });

  assert.equal(result.status, "success");
  if (result.status === "success") {
    const written = await fs.readFile(result.output_path);
    assert.ok(written.length > 0);
  }

  // The source file should have actually been copied into ComfyUI's own
  // input/ dir (LoadImage only reads relative to it) — confirms the real
  // stageInputImage wiring ran, not just a fixture stand-in.
  const stagedFiles = await fs.readdir(path.join(engineDir, "input"));
  assert.equal(stagedFiles.length, 1);
  assert.match(stagedFiles[0], /^upload_\d+_[0-9a-f]+\.png$/);

  await orchestrator.shutdown();
});

test("setDefaultModel persists a choice that getModelSelection then honors", async () => {
  const paths = await tmpPaths();
  const settings = await tmpSettings(paths);
  const registry = [
    makeEntry({ id: "high-tier", quality_tier: 3 }),
    makeEntry({ id: "low-tier", quality_tier: 1 })
  ];
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry, settings });

  const before = await orchestrator.getModelSelection("text-to-image");
  assert.equal(before.default?.id, "high-tier");

  await orchestrator.setDefaultModel("text-to-image", "low-tier");

  const after = await orchestrator.getModelSelection("text-to-image");
  assert.equal(after.default?.id, "low-tier");
  assert.deepEqual(after.alternates.map((e) => e.id), ["high-tier"]);
});

test("setDefaultModel rejects a model that belongs to a different task", async () => {
  const paths = await tmpPaths();
  const registry = [makeEntry({ id: "video-model", task: "text-to-video" })];
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry, settings: await tmpSettings(paths) });

  await assert.rejects(
    () => orchestrator.setDefaultModel("text-to-image", "video-model"),
    /is not a text-to-image model/
  );
});

test("a persisted default that's no longer compatible falls back to the computed default", async () => {
  const paths = await tmpPaths();
  const settings = await tmpSettings(paths);
  await settings.setDefaultModelId("text-to-image", "since-removed");

  const registry = [makeEntry({ id: "still-here", quality_tier: 2 })];
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry, settings });

  const selection = await orchestrator.getModelSelection("text-to-image");
  assert.equal(selection.default?.id, "still-here");
});

test("the override persists across a fresh Orchestrator built from the same settings file (simulating a restart)", async () => {
  const paths = await tmpPaths();
  const registry = [
    makeEntry({ id: "high-tier", quality_tier: 3 }),
    makeEntry({ id: "low-tier", quality_tier: 1 })
  ];

  const first = new Orchestrator({ paths, profile: fakeProfile(), registry, settings: await tmpSettings(paths) });
  await first.setDefaultModel("text-to-image", "low-tier");

  const second = new Orchestrator({ paths, profile: fakeProfile(), registry, settings: await tmpSettings(paths) });
  const selection = await second.getModelSelection("text-to-image");
  assert.equal(selection.default?.id, "low-tier");
});

test("generateMusic returns a clear error when the audio engine isn't installed", async () => {
  const paths = await tmpPaths();
  const entry = makeEntry({ id: "musicgen-small", task: "text-to-music", engine: "python" });
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [entry], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateMusic("musicgen-small", { prompt: "calm piano" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /audio engine isn't installed yet/);
  }
});

test("generateMusic returns a clear error for an unknown model", async () => {
  const paths = await tmpPaths();
  const orchestrator = new Orchestrator({ paths, profile: fakeProfile(), registry: [], settings: await tmpSettings(paths) });

  const result = await orchestrator.generateMusic("does-not-exist", { prompt: "calm piano" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.match(result.error, /Unknown model/);
  }
});

test("generateMusic runs the full pipeline end to end against a fixture audio server, including a model switch", async () => {
  const paths = await tmpPaths();
  const entryA = makeEntry({ id: "musicgen-small", task: "text-to-music", engine: "python" });
  const entryB = makeEntry({ id: "musicgen-medium", task: "text-to-music", engine: "python" });

  // Stand in for a real audio engine install: a marker python.exe so
  // venvExists() passes, and a prepared model dir (config.json) per
  // model, same as installModelById would leave behind for real.
  const venvDir = path.join(paths.venvsDir, "python");
  await fs.mkdir(path.join(venvDir, "Scripts"), { recursive: true });
  await fs.writeFile(path.join(venvDir, "Scripts", "python.exe"), "stand-in marker file");
  for (const id of ["musicgen-small", "musicgen-medium"]) {
    const modelDir = path.join(paths.modelsDir, `${id}-hf`);
    await fs.mkdir(modelDir, { recursive: true });
    await fs.writeFile(path.join(modelDir, "config.json"), "{}");
  }

  const fixtureScript = path.join(__dirname, "audio", "testFixtures", "fakeAudioServer.js");

  const net = await import("net");
  const reservePort = () =>
    new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as any).port;
        srv.close(() => resolve(p));
      });
      srv.on("error", reject);
    });

  const orchestrator = new Orchestrator({
    paths,
    profile: fakeProfile(),
    registry: [entryA, entryB],
    settings: await tmpSettings(paths),
    audioPort: await reservePort(),
    resolveAudioLaunchCommand: (_venvDir, modelDir, p) => ({
      command: process.execPath,
      args: [fixtureScript, modelDir, String(p)]
    })
  });

  const first = await orchestrator.generateMusic("musicgen-small", { prompt: "calm piano", durationSeconds: 5 });
  assert.equal(first.status, "success");
  if (first.status === "success") {
    const written = await fs.readFile(first.output_path);
    assert.ok(written.length > 0);
  }

  // Switching models kills the old process and starts a fresh one — proves
  // the restart path works, not just first-launch.
  const second = await orchestrator.generateMusic("musicgen-medium", { prompt: "upbeat drums" });
  assert.equal(second.status, "success");

  await orchestrator.shutdown();
});
