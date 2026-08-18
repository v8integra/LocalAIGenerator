import { ChildProcess, spawn } from "child_process";

export interface ComfyProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  port: number;
  healthCheckPath?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ComfyProcessHandle {
  port: number;
  kill: () => Promise<void>;
}

/**
 * Spawns the backend engine subprocess (ComfyUI or the audio Python
 * process) and waits until its HTTP API responds, per spec §4.4 — the
 * app only ever talks to it over HTTP, never opens its own UI.
 */
export async function startComfyProcess(options: ComfyProcessOptions): Promise<ComfyProcessHandle> {
  const healthCheckPath = options.healthCheckPath ?? "/system_stats";
  const readyTimeoutMs = options.readyTimeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env ?? process.env });

  let stderrOutput = "";
  child.stderr?.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  let ready = false;
  let exitError: Error | null = null;
  child.on("exit", (code, signal) => {
    if (!ready) {
      exitError = new Error(
        `Process exited before becoming ready (code ${code}, signal ${signal}): ${stderrOutput.trim()}`
      );
    }
  });

  const healthUrl = `http://127.0.0.1:${options.port}${healthCheckPath}`;
  const deadline = Date.now() + readyTimeoutMs;

  while (!ready) {
    if (exitError) {
      throw exitError;
    }
    if (Date.now() > deadline) {
      await killProcess(child);
      throw new Error(`Timed out waiting for process to become ready at ${healthUrl}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await sleep(pollIntervalMs);
  }

  return {
    port: options.port,
    kill: () => killProcess(child)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
  });
}
