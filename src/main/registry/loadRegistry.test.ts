import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { loadBundledRegistry, loadRegistryFromPath } from "./loadRegistry";

const TASK_TYPES = ["text-to-image", "text-to-video", "text-to-music", "image-to-image"];

test("loads and validates the bundled registry", async () => {
  const entries = await loadBundledRegistry();

  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(typeof entry.id, "string");
    assert.ok(TASK_TYPES.includes(entry.task));
  }
});

test("every task type has at least one bundled model", async () => {
  const entries = await loadBundledRegistry();
  const tasksCovered = new Set(entries.map((e) => e.task));

  for (const task of TASK_TYPES) {
    assert.ok(tasksCovered.has(task as any), `no bundled model for task "${task}"`);
  }
});

test("rejects a file that isn't valid JSON", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const badPath = path.join(tmpDir, "models.json");
  await fs.writeFile(badPath, "{ not json");

  await assert.rejects(() => loadRegistryFromPath(badPath), /not valid JSON/);
});

test("rejects a JSON body that isn't an array", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const badPath = path.join(tmpDir, "models.json");
  await fs.writeFile(badPath, JSON.stringify({ id: "not-an-array" }));

  await assert.rejects(() => loadRegistryFromPath(badPath), /must be a JSON array/);
});

test("rejects an entry missing a required field", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const badPath = path.join(tmpDir, "models.json");
  await fs.writeFile(badPath, JSON.stringify([{ id: "incomplete" }]));

  await assert.rejects(() => loadRegistryFromPath(badPath), /missing or invalid "task" field/);
});

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    download_url: "https://example.com/model.safetensors",
    checksum: "sha256:abc",
    quality_tier: 1,
    is_default_candidate: true,
    ...overrides
  };
}

test("accepts an entry with a valid sampling_preset", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const goodPath = path.join(tmpDir, "models.json");
  await fs.writeFile(
    goodPath,
    JSON.stringify([validEntry({ sampling_preset: { steps: 4, cfg: 1.0, sampler_name: "euler", scheduler: "normal" } })])
  );

  const entries = await loadRegistryFromPath(goodPath);
  assert.deepEqual(entries[0].sampling_preset, { steps: 4, cfg: 1.0, sampler_name: "euler", scheduler: "normal" });
});

test("loads an entry with no sampling_preset at all just fine", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const goodPath = path.join(tmpDir, "models.json");
  await fs.writeFile(goodPath, JSON.stringify([validEntry()]));

  const entries = await loadRegistryFromPath(goodPath);
  assert.equal(entries[0].sampling_preset, undefined);
});

test("rejects a sampling_preset missing required fields", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const badPath = path.join(tmpDir, "models.json");
  await fs.writeFile(badPath, JSON.stringify([validEntry({ sampling_preset: { cfg: 1.0 } })]));

  await assert.rejects(() => loadRegistryFromPath(badPath), /missing or invalid "sampling_preset\.steps" field/);
});

test("the bundled SDXL Turbo entries have a sampling_preset tuned for a distilled/turbo model", async () => {
  const entries = await loadBundledRegistry();
  const turboEntries = entries.filter((e) => e.id === "sdxl-turbo" || e.id === "sdxl-turbo-img2img");

  assert.ok(turboEntries.length > 0, "expected sdxl-turbo entries in the bundled registry");
  for (const entry of turboEntries) {
    assert.ok(entry.sampling_preset, `${entry.id} should have a sampling_preset`);
    assert.ok(entry.sampling_preset!.steps <= 8, "turbo models should use a low step count");
    assert.ok(entry.sampling_preset!.cfg <= 2, "turbo models should use a near-zero cfg");
  }
});

test("the bundled SDXL Base entry uses its native ~1024x1024 resolution, not buildTxt2ImgWorkflow's SD1.x-tuned 512 default", async () => {
  const entries = await loadBundledRegistry();
  const sdxlBase = entries.find((e) => e.id === "sdxl-base");

  assert.ok(sdxlBase?.sampling_preset, "sdxl-base should have a sampling_preset");
  assert.ok(sdxlBase!.sampling_preset!.width! >= 1024, "SDXL Base needs ~1024px width to avoid malformed output");
  assert.ok(sdxlBase!.sampling_preset!.height! >= 1024, "SDXL Base needs ~1024px height to avoid malformed output");
});

test("AnimateDiff Lightning and v2 have distinctly different sampling_presets, matching their distillation status", async () => {
  const entries = await loadBundledRegistry();
  const lightning = entries.find((e) => e.id === "animatediff-lightning");
  const v2 = entries.find((e) => e.id === "animatediff-v2");

  assert.ok(lightning?.sampling_preset, "animatediff-lightning should have a sampling_preset");
  assert.ok(v2?.sampling_preset, "animatediff-v2 should have a sampling_preset");

  // Lightning is a 4-step distilled model — few steps, near-zero cfg.
  assert.ok(lightning!.sampling_preset!.steps <= 8);
  assert.ok(lightning!.sampling_preset!.cfg <= 2);

  // v2 is the original, non-distilled motion module — needs standard
  // SD1.x-style sampling, not Lightning's fast/low-cfg settings. Using
  // Lightning's preset on v2 was verified live to produce an
  // unrecognizable blurry blob instead of a real scene.
  assert.ok(v2!.sampling_preset!.steps >= 15);
  assert.ok(v2!.sampling_preset!.cfg >= 5);
});
