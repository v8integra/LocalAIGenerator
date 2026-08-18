import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { computeChecksum, parseChecksum, verifyChecksum } from "./verifyChecksum";

async function tmpFile(content: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checksum-test-"));
  const filePath = path.join(dir, "file.bin");
  await fs.writeFile(filePath, content);
  return filePath;
}

test("parseChecksum splits algorithm and hash", () => {
  assert.deepEqual(parseChecksum("sha256:ABCDEF"), { algorithm: "sha256", hash: "abcdef" });
});

test("parseChecksum rejects a string with no separator", () => {
  assert.throws(() => parseChecksum("not-a-checksum"), /Malformed checksum/);
});

test("computeChecksum matches Node's own sha256 of the same content", async () => {
  const content = crypto.randomBytes(4096);
  const filePath = await tmpFile(content);

  const expected = crypto.createHash("sha256").update(content).digest("hex");
  const actual = await computeChecksum(filePath, "sha256");

  assert.equal(actual, expected);
});

test("verifyChecksum returns true for a matching file", async () => {
  const content = Buffer.from("hello world");
  const filePath = await tmpFile(content);
  const expected = crypto.createHash("sha256").update(content).digest("hex");

  assert.equal(await verifyChecksum(filePath, `sha256:${expected}`), true);
});

test("verifyChecksum returns false for a mismatched file", async () => {
  const filePath = await tmpFile(Buffer.from("hello world"));

  assert.equal(await verifyChecksum(filePath, "sha256:0000000000000000000000000000000000000000000000000000000000000000"), false);
});

test("verifyChecksum is case-insensitive", async () => {
  const content = Buffer.from("hello world");
  const filePath = await tmpFile(content);
  const expected = crypto.createHash("sha256").update(content).digest("hex").toUpperCase();

  assert.equal(await verifyChecksum(filePath, `sha256:${expected}`), true);
});
