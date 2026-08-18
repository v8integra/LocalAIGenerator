import { test } from "node:test";
import * as assert from "node:assert/strict";
import { HardwareProfile } from "../hardware/detectHardware";
import { getCompatibleModels, selectModelForTask } from "./selectModel";
import { ModelEntry } from "./types";

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
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

function makeEntry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    id: "test-model",
    task: "text-to-image",
    label: "Test Model",
    engine: "comfyui",
    min_vram_gb: 4,
    recommended_vram_gb: 6,
    os_support: ["windows"],
    disk_gb: 5,
    content_policy: "moderate",
    download_url: "TODO",
    checksum: "TODO",
    quality_tier: 1,
    is_default_candidate: true,
    ...overrides
  };
}

test("picks the highest quality_tier among VRAM-compatible entries as default", () => {
  const entries = [
    makeEntry({ id: "low", quality_tier: 1, min_vram_gb: 4 }),
    makeEntry({ id: "high", quality_tier: 3, min_vram_gb: 6 }),
    makeEntry({ id: "mid", quality_tier: 2, min_vram_gb: 4 })
  ];

  const result = selectModelForTask(entries, "text-to-image", makeProfile({ vram_gb: 8 }));

  assert.equal(result.default?.id, "high");
  assert.deepEqual(result.alternates.map((e) => e.id), ["mid", "low"]);
});

test("excludes entries that need more VRAM than the profile has", () => {
  const entries = [
    makeEntry({ id: "too-big", quality_tier: 3, min_vram_gb: 12 }),
    makeEntry({ id: "fits", quality_tier: 1, min_vram_gb: 4 })
  ];

  const result = selectModelForTask(entries, "text-to-image", makeProfile({ vram_gb: 8 }));

  assert.equal(result.default?.id, "fits");
  assert.equal(result.alternates.length, 0);
});

test("excludes entries for other tasks", () => {
  const entries = [
    makeEntry({ id: "img", task: "text-to-image" }),
    makeEntry({ id: "vid", task: "text-to-video" })
  ];

  const result = selectModelForTask(entries, "text-to-image", makeProfile());

  assert.equal(result.default?.id, "img");
  assert.equal(result.alternates.length, 0);
});

test("excludes entries that don't support the current OS", () => {
  const entries = [makeEntry({ id: "mac-only", os_support: ["mac"] })];

  const result = selectModelForTask(entries, "text-to-image", makeProfile({ os: "windows" }));

  assert.equal(result.default, null);
  assert.deepEqual(result.alternates, []);
});

test("returns a null default and no alternates when nothing is compatible", () => {
  const result = selectModelForTask([], "text-to-image", makeProfile());

  assert.equal(result.default, null);
  assert.deepEqual(result.alternates, []);
});

test("getCompatibleModels sorts strictly by quality_tier descending", () => {
  const entries = [
    makeEntry({ id: "a", quality_tier: 2 }),
    makeEntry({ id: "b", quality_tier: 5 }),
    makeEntry({ id: "c", quality_tier: 3 })
  ];

  const result = getCompatibleModels(entries, "text-to-image", makeProfile());

  assert.deepEqual(result.map((e) => e.id), ["b", "c", "a"]);
});
