import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function pythonBinPath(venvPath: string): string {
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

export async function venvExists(venvPath: string): Promise<boolean> {
  try {
    await fs.access(pythonBinPath(venvPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a real system Python, explicitly avoiding the Windows Store's
 * "App Execution Alias" stub at .../WindowsApps/python.exe. That stub
 * resolves first on PATH but carries its own MSIX package identity, which
 * silently redirects any writes under AppData\Roaming into a private,
 * invisible package cache — `python -m venv` under an app data path
 * reports success but the venv is never visible to fs.access() at the
 * requested path. This only affects paths under AppData\Roaming (where
 * this app's real venvs live), not os.tmpdir(), which is why tests never
 * caught it.
 */
export async function resolveSystemPython(): Promise<string> {
  if (process.platform !== "win32") return "python3";

  const { stdout } = await execFileAsync("where", ["python"]);
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const realCandidate = candidates.find((candidatePath) => !candidatePath.toLowerCase().includes("windowsapps"));
  return realCandidate ?? candidates[0] ?? "python";
}

/** Creates an isolated venv using the system Python (spec §3: never a system-wide install). */
export async function createVenv(venvPath: string, basePython?: string): Promise<void> {
  const resolvedPython = basePython ?? (await resolveSystemPython());
  await execFileAsync(resolvedPython, ["-m", "venv", venvPath], { timeout: 120000 });
}

/** Installs pinned dependency versions into an existing venv (spec §4.3). */
export async function installDependencies(venvPath: string, packages: string[]): Promise<void> {
  if (packages.length === 0) return;
  await runPip(venvPath, ["install", ...packages]);
}

/**
 * Runs an arbitrary pip command inside the venv — e.g. `install -r
 * requirements.txt` or `install torch --extra-index-url <url>`, which
 * installDependencies' plain package-list form can't express. pipArgs'
 * first element is the pip subcommand (e.g. "install").
 */
export async function runPip(venvPath: string, pipArgs: string[], timeoutMs = 600000): Promise<void> {
  const [command, ...rest] = pipArgs;
  await execFileAsync(pythonBinPath(venvPath), ["-m", "pip", command, "--disable-pip-version-check", ...rest], {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
}

/** Runs a script inside the venv's Python, e.g. for a model's smoke test. */
export async function runPythonInVenv(
  venvPath: string,
  args: string[],
  timeoutMs = 60000
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(pythonBinPath(venvPath), args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
}

/**
 * Verifies specific packages are actually importable, not just that the
 * venv directory happens to exist. A venv can be left with python.exe in
 * place but an incomplete package set if pip was interrupted partway
 * (network drop, disk space, antivirus interference, etc.) — treating
 * bare venv existence as "engine fully installed" then means that broken
 * state is never retried. This runs a real import in the venv's own
 * interpreter, so it catches exactly the failure a caller would hit.
 */
export async function packagesImportable(venvPath: string, packages: string[]): Promise<boolean> {
  try {
    await runPythonInVenv(venvPath, ["-c", packages.map((pkg) => `import ${pkg}`).join("; ")], 15000);
    return true;
  } catch {
    return false;
  }
}
