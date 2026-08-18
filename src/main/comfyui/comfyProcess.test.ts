import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "net";
import * as path from "path";
import { startComfyProcess } from "./comfyProcess";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

const fixtureScript = path.join(__dirname, "testFixtures", "fakeComfyServer.js");

test("starts a process and waits until its health check responds", async () => {
  const port = await freePort();

  const handle = await startComfyProcess({
    command: process.execPath,
    args: [fixtureScript, `--port=${port}`],
    port,
    readyTimeoutMs: 10000
  });

  assert.equal(handle.port, port);

  const response = await fetch(`http://127.0.0.1:${port}/system_stats`);
  assert.equal(response.ok, true);

  await handle.kill();
});

test("kill() actually terminates the process", async () => {
  const port = await freePort();
  const handle = await startComfyProcess({
    command: process.execPath,
    args: [fixtureScript, `--port=${port}`],
    port,
    readyTimeoutMs: 10000
  });

  await handle.kill();

  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(1000) }));
});

test("rejects with a clear error if the process exits before becoming ready", async () => {
  const port = await freePort();

  await assert.rejects(
    () =>
      startComfyProcess({
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        port,
        readyTimeoutMs: 5000
      }),
    /Process exited before becoming ready/
  );
});

test("times out if nothing ever answers the health check", async () => {
  const port = await freePort();

  await assert.rejects(
    () =>
      startComfyProcess({
        command: process.execPath,
        // Spawns a process that stays alive but never opens the port.
        args: ["-e", "setTimeout(() => {}, 60000)"],
        port,
        readyTimeoutMs: 500,
        pollIntervalMs: 100
      }),
    /Timed out waiting for process to become ready/
  );
});
