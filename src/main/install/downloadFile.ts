import * as fs from "fs";
import * as path from "path";

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Downloads a URL to destPath, resuming from an existing partial download
 * if one is present (spec §4.3: resumable downloads via HTTP range
 * requests). Writes to a ".part" sibling and renames on success, so a
 * partial or failed download is never mistaken for a complete one.
 */
export async function downloadFile(url: string, destPath: string, onProgress?: ProgressCallback): Promise<void> {
  const partPath = `${destPath}.part`;
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  let startByte = await partialFileSize(partPath);

  const headers: Record<string, string> = {};
  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-`;
  }

  const response = await fetch(url, { headers });

  if (startByte > 0 && response.status === 416) {
    // The server says there's nothing left past our resume point — treat
    // the existing partial file as already complete.
    await response.body?.cancel();
    await fs.promises.rename(partPath, destPath);
    onProgress?.({ downloadedBytes: startByte, totalBytes: startByte });
    return;
  }

  if (startByte > 0 && response.status === 200) {
    // Server ignored the Range header and sent the whole file — restart.
    startByte = 0;
    await fs.promises.rm(partPath, { force: true });
  } else if (startByte > 0 && response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`Server returned unexpected status ${response.status} while resuming download from ${url}`);
  } else if (startByte === 0 && !response.ok) {
    await response.body?.cancel();
    throw new Error(`Download failed with status ${response.status} for ${url}`);
  }

  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? startByte + Number(contentLength) : null;

  const writeStream = fs.createWriteStream(partPath, { flags: startByte > 0 ? "a" : "w" });
  let downloadedBytes = startByte;

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedBytes += value.byteLength;
      await writeChunk(writeStream, Buffer.from(value));
      onProgress?.({ downloadedBytes, totalBytes });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  }

  await fs.promises.rename(partPath, destPath);
}

async function partialFileSize(partPath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(partPath);
    return stat.size;
  } catch {
    return 0;
  }
}

function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}
