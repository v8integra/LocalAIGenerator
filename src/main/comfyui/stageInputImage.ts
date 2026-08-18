import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * ComfyUI's LoadImage node only reads from its own input/ directory
 * (folder_paths.get_input_directory(), verified from nodes.py/folder_paths.py
 * source), not an arbitrary absolute path — so a user-selected source image
 * has to be copied there before a workflow can reference it. Returns just
 * the filename, which is what LoadImage's "image" input expects.
 */
export async function stageInputImage(sourcePath: string, engineDir: string): Promise<string> {
  const inputDir = path.join(engineDir, "input");
  await fs.mkdir(inputDir, { recursive: true });

  const ext = path.extname(sourcePath) || ".png";
  const destFilename = `upload_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
  await fs.copyFile(sourcePath, path.join(inputDir, destFilename));

  return destFilename;
}
