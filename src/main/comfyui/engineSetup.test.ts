import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { writeExtraModelPaths } from "./engineSetup";

test("writeExtraModelPaths points ComfyUI's checkpoints dir directly at our models dir", async () => {
  const engineDir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-setup-test-"));
  const modelsDir = "C:\\Users\\Raven\\AppData\\Roaming\\local-ai-studio\\models";

  await writeExtraModelPaths(engineDir, modelsDir);

  const written = await fs.readFile(path.join(engineDir, "extra_model_paths.yaml"), "utf-8");

  assert.match(written, /local_ai_studio:/);
  assert.match(written, /base_path: C:\/Users\/Raven\/AppData\/Roaming\/local-ai-studio\/models/);
  assert.match(written, /checkpoints: \./);
  assert.match(written, /animatediff_models: \./);
  // No literal backslashes should survive into the YAML.
  assert.equal(written.includes("\\"), false);
});
