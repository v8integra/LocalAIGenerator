import * as fs from "fs/promises";

/**
 * Clears and recreates the temp output directory. Called both on app
 * launch — before anything else, to discard leftovers from a session that
 * ended in a crash — and on quit, per spec §4.5.
 */
export async function resetTempDir(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
}
