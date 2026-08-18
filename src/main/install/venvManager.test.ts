import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createVenv, installDependencies, resolveSystemPython, runPythonInVenv, venvExists } from "./venvManager";

async function tmpVenvPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "venv-test-"));
  return path.join(dir, "venv");
}

test("venvExists is false for a path that was never created", async () => {
  const venvPath = await tmpVenvPath();
  assert.equal(await venvExists(venvPath), false);
});

test("resolveSystemPython avoids the Windows Store App Execution Alias stub", async () => {
  const resolved = await resolveSystemPython();
  assert.equal(resolved.toLowerCase().includes("windowsapps"), false);
});

test("createVenv produces a working Python environment", async () => {
  const venvPath = await tmpVenvPath();

  await createVenv(venvPath);

  assert.equal(await venvExists(venvPath), true);

  const { stdout } = await runPythonInVenv(venvPath, ["-c", "print('ok')"]);
  assert.equal(stdout.trim(), "ok");
});

test("installDependencies with an empty list is a no-op", async () => {
  const venvPath = await tmpVenvPath();
  await createVenv(venvPath);

  // Would hang/fail if this tried to invoke pip with no packages.
  await installDependencies(venvPath, []);
});

test("installDependencies installs a real pinned package usable inside the venv", async () => {
  const venvPath = await tmpVenvPath();
  await createVenv(venvPath);

  await installDependencies(venvPath, ["six==1.16.0"]);

  const { stdout } = await runPythonInVenv(venvPath, ["-c", "import six; print(six.__version__)"]);
  assert.equal(stdout.trim(), "1.16.0");
});
