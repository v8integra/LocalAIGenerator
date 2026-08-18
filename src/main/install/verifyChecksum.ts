import * as crypto from "crypto";
import * as fs from "fs";

/** Parses the registry's "<algorithm>:<hex>" checksum format (spec §4.2). */
export function parseChecksum(checksum: string): { algorithm: string; hash: string } {
  const separatorIndex = checksum.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed checksum "${checksum}", expected "<algorithm>:<hex>"`);
  }
  const algorithm = checksum.slice(0, separatorIndex);
  const hash = checksum.slice(separatorIndex + 1).toLowerCase();
  if (!algorithm || !hash) {
    throw new Error(`Malformed checksum "${checksum}", expected "<algorithm>:<hex>"`);
  }
  return { algorithm, hash };
}

export function computeChecksum(filePath: string, algorithm: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Verifies a downloaded file against the registry's checksum field (spec §4.3). */
export async function verifyChecksum(filePath: string, checksum: string): Promise<boolean> {
  const { algorithm, hash } = parseChecksum(checksum);
  const actual = await computeChecksum(filePath, algorithm);
  return actual === hash;
}
