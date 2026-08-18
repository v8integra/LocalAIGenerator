import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseHfRepoAndFilename, prepareModelDir } from "./prepareModelDir";

test("parseHfRepoAndFilename extracts repo id and filename from a resolve URL", () => {
  const result = parseHfRepoAndFilename("https://huggingface.co/facebook/musicgen-small/resolve/main/model.safetensors");
  assert.deepEqual(result, { repoId: "facebook/musicgen-small", filename: "model.safetensors" });
});

test("parseHfRepoAndFilename handles nested filenames", () => {
  const result = parseHfRepoAndFilename("https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors");
  assert.deepEqual(result, { repoId: "stabilityai/sdxl-turbo", filename: "sd_xl_turbo_1.0_fp16.safetensors" });
});

test("parseHfRepoAndFilename throws a clear error on an unrecognized URL shape", () => {
  assert.throws(() => parseHfRepoAndFilename("https://example.com/not-huggingface"), /Could not parse/);
});

test("prepareModelDir hard-links the weights file under its HF filename and fetches real companion files", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-model-dir-test-"));
  const fakeWeightsPath = path.join(base, "musicgen-small.safetensors");
  await fs.writeFile(fakeWeightsPath, "not the real weights, just testing the plumbing");

  const targetDir = path.join(base, "musicgen-small-hf");
  const downloadUrl = "https://huggingface.co/facebook/musicgen-small/resolve/main/model.safetensors";

  await prepareModelDir(fakeWeightsPath, downloadUrl, targetDir);

  const weightsInTarget = await fs.readFile(path.join(targetDir, "model.safetensors"), "utf-8");
  assert.equal(weightsInTarget, "not the real weights, just testing the plumbing");

  const configRaw = await fs.readFile(path.join(targetDir, "config.json"), "utf-8");
  const config = JSON.parse(configRaw);
  assert.equal(typeof config, "object");

  const tokenizerConfigStat = await fs.stat(path.join(targetDir, "tokenizer_config.json"));
  assert.ok(tokenizerConfigStat.size > 0);
});
