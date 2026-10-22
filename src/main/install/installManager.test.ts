import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ModelEntry } from "../registry/types";
import { installModel, InstallEvent } from "./installManager";
import { TestHttpServer } from "./testFixtures/httpServer";

async function tmpDirs(): Promise<{ modelsDir: string; venvDir: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "install-test-"));
  return { modelsDir: path.join(base, "models"), venvDir: path.join(base, "venv") };
}

function makeEntry(overrides: Partial<ModelEntry> & { download_url: string; checksum: string }): ModelEntry {
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
    quality_tier: 1,
    is_default_candidate: true,
    ...overrides
  };
}

test("installs a model end to end: download, checksum, venv, smoke test, ready", async () => {
  const body = crypto.randomBytes(32 * 1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const { modelsDir, venvDir } = await tmpDirs();

  const entry = makeEntry({ download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });

  const events: InstallEvent[] = [];
  let smokeTestCalledWith: { venvPath: string; modelPath: string } | null = null;

  const result = await installModel(entry, {
    modelsDir,
    venvDir,
    pinnedDependencies: [],
    smokeTest: async (venvPath, modelPath) => {
      smokeTestCalledWith = { venvPath, modelPath };
      const stat = await fs.stat(modelPath);
      assert.equal(stat.size, body.length);
    },
    onProgress: (event) => events.push(event)
  });

  assert.deepEqual(await fs.readFile(result.modelPath), body);
  assert.equal(result.venvPath, venvDir);
  assert.ok(smokeTestCalledWith !== null);
  assert.equal(events.at(-1)?.phase, "ready");
  assert.ok(events.some((e) => e.phase === "creating-venv"));
  assert.ok(events.some((e) => e.phase === "smoke-testing"));

  await server.close();
});

test("aborts after two checksum mismatches without ever running the smoke test", async () => {
  const body = crypto.randomBytes(8 * 1024);
  const server = new TestHttpServer(body); // always serves `body`, never matching...
  const url = await server.listen();
  const { modelsDir, venvDir } = await tmpDirs();

  const wrongChecksum = "0".repeat(64); // ...because this is not sha256(body)
  const entry = makeEntry({ download_url: `${url}model.bin`, checksum: `sha256:${wrongChecksum}` });

  let smokeTestCalls = 0;
  const events: InstallEvent[] = [];

  await assert.rejects(
    () =>
      installModel(entry, {
        modelsDir,
        venvDir,
        pinnedDependencies: [],
        smokeTest: async () => {
          smokeTestCalls++;
        },
        onProgress: (event) => events.push(event)
      }),
    /Checksum verification failed 2 times/
  );

  assert.equal(smokeTestCalls, 0);
  assert.equal(events.at(-1)?.phase, "failed");
  assert.ok(!events.some((e) => e.phase === "creating-venv"));

  await server.close();
});

test("does not mark the model ready when the smoke test fails", async () => {
  const body = crypto.randomBytes(8 * 1024);
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const { modelsDir, venvDir } = await tmpDirs();

  const entry = makeEntry({ download_url: `${url}model.bin`, checksum: `sha256:${checksum}` });
  const events: InstallEvent[] = [];

  await assert.rejects(
    () =>
      installModel(entry, {
        modelsDir,
        venvDir,
        pinnedDependencies: [],
        smokeTest: async () => {
          throw new Error("boom");
        },
        onProgress: (event) => events.push(event)
      }),
    /Smoke test failed for model "test-model": boom/
  );

  assert.equal(events.at(-1)?.phase, "failed");
  assert.ok(!events.some((e) => e.phase === "ready"));

  await server.close();
});

test("downloads an entry's components under their own filenames, skipping ones already present", async () => {
  const body = crypto.randomBytes(16 * 1024);
  const checksum = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const { modelsDir, venvDir } = await tmpDirs();

  // Pretend another entry already installed the shared VAE — a wrong-content
  // file proves it's reused rather than re-downloaded over.
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelsDir, "shared_vae.safetensors"), "already here");

  const entry = makeEntry({
    download_url: `${url}unet.safetensors`,
    checksum,
    components: [
      { role: "text_encoder", download_url: `${url}split_files/text_encoders/qwen.safetensors`, checksum },
      { role: "vae", download_url: `${url}shared_vae.safetensors`, checksum }
    ]
  });

  await installModel(entry, { modelsDir, venvDir, pinnedDependencies: [], smokeTest: async () => {} });

  assert.deepEqual(await fs.readFile(path.join(modelsDir, "qwen.safetensors")), body);
  assert.equal(await fs.readFile(path.join(modelsDir, "shared_vae.safetensors"), "utf-8"), "already here");

  await server.close();
});
