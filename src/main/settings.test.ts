import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { SettingsStore } from "./settings";

async function tmpSettingsPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-test-"));
  return path.join(dir, "settings.json");
}

test("returns undefined for a task with no override when no file exists yet", async () => {
  const store = await SettingsStore.load(await tmpSettingsPath());
  assert.equal(store.getDefaultModelId("text-to-image"), undefined);
});

test("setDefaultModelId persists to disk and is readable via getDefaultModelId", async () => {
  const filePath = await tmpSettingsPath();
  const store = await SettingsStore.load(filePath);

  await store.setDefaultModelId("text-to-image", "sd15");

  assert.equal(store.getDefaultModelId("text-to-image"), "sd15");
});

test("persists across separate SettingsStore instances (simulating an app restart)", async () => {
  const filePath = await tmpSettingsPath();
  const first = await SettingsStore.load(filePath);
  await first.setDefaultModelId("text-to-video", "animatediff-lightning");

  const second = await SettingsStore.load(filePath);
  assert.equal(second.getDefaultModelId("text-to-video"), "animatediff-lightning");
});

test("falls back to defaults when the settings file is corrupt", async () => {
  const filePath = await tmpSettingsPath();
  await fs.writeFile(filePath, "{ this is not valid json");

  const store = await SettingsStore.load(filePath);

  assert.equal(store.getDefaultModelId("text-to-image"), undefined);
  // Confirms the store still works normally after recovering from corruption.
  await store.setDefaultModelId("text-to-image", "sd15");
  assert.equal(store.getDefaultModelId("text-to-image"), "sd15");
});

test("falls back to defaults when the settings file has the wrong shape", async () => {
  const filePath = await tmpSettingsPath();
  await fs.writeFile(filePath, JSON.stringify(["not", "the", "right", "shape"]));

  const store = await SettingsStore.load(filePath);

  assert.equal(store.getDefaultModelId("text-to-image"), undefined);
});

test("tracks independent overrides per task", async () => {
  const filePath = await tmpSettingsPath();
  const store = await SettingsStore.load(filePath);

  await store.setDefaultModelId("text-to-image", "sd15");
  await store.setDefaultModelId("text-to-video", "animatediff-lightning");

  assert.equal(store.getDefaultModelId("text-to-image"), "sd15");
  assert.equal(store.getDefaultModelId("text-to-video"), "animatediff-lightning");
  assert.equal(store.getDefaultModelId("text-to-music"), undefined);
});
