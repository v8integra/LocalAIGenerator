import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { downloadFile } from "./downloadFile";
import { TestHttpServer } from "./testFixtures/httpServer";

async function tmpDest(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-test-"));
  return path.join(dir, "model.bin");
}

test("downloads a file fully and reports final progress", async () => {
  const body = crypto.randomBytes(64 * 1024);
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const dest = await tmpDest();

  const progressEvents: { downloadedBytes: number; totalBytes: number | null }[] = [];
  await downloadFile(url, dest, (p) => progressEvents.push(p));

  const written = await fs.readFile(dest);
  assert.deepEqual(written, body);
  assert.ok(progressEvents.length > 0);
  assert.equal(progressEvents.at(-1)?.downloadedBytes, body.length);
  assert.equal(progressEvents.at(-1)?.totalBytes, body.length);

  await server.close();
});

test("resumes from an existing partial file using a Range request", async () => {
  const body = crypto.randomBytes(128 * 1024);
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const dest = await tmpDest();

  const partialLength = 50 * 1024;
  await fs.writeFile(`${dest}.part`, body.subarray(0, partialLength));

  await downloadFile(url, dest);

  const written = await fs.readFile(dest);
  assert.deepEqual(written, body);

  const rangeRequest = server.requests.find((r) => r.range);
  assert.equal(rangeRequest?.range, `bytes=${partialLength}-`);

  await server.close();
});

test("restarts cleanly when the server ignores the Range header", async () => {
  const body = crypto.randomBytes(32 * 1024);
  const server = new TestHttpServer(body);
  server.ignoreRange = true;
  const url = await server.listen();
  const dest = await tmpDest();

  await fs.writeFile(`${dest}.part`, crypto.randomBytes(10 * 1024));

  await downloadFile(url, dest);

  const written = await fs.readFile(dest);
  assert.deepEqual(written, body);

  await server.close();
});

test("treats a 416 response as an already-complete download", async () => {
  const body = crypto.randomBytes(16 * 1024);
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const dest = await tmpDest();

  // Partial file already holds every byte, just hasn't been renamed yet.
  await fs.writeFile(`${dest}.part`, body);

  await downloadFile(url, dest);

  const written = await fs.readFile(dest);
  assert.deepEqual(written, body);

  await server.close();
});

test("throws a clear error on a non-206/416 status while resuming", async () => {
  const body = crypto.randomBytes(16 * 1024);
  const server = new TestHttpServer(body);
  const url = await server.listen();
  const dest = await tmpDest();
  await fs.writeFile(`${dest}.part`, body.subarray(0, 1024));

  server.forceStatus = 500;

  await assert.rejects(() => downloadFile(url, dest), /unexpected status 500/);

  await server.close();
});

test("throws a clear error when the initial request fails", async () => {
  const server = new TestHttpServer(Buffer.from("irrelevant"));
  const url = await server.listen();
  await server.close(); // force connection failures for any request

  const dest = await tmpDest();
  await assert.rejects(() => downloadFile(url, dest));
});
