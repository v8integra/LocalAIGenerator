import * as fs from "fs/promises";
import * as path from "path";
import { buildOutputFilename } from "../outputFilename";
import { generateAudio } from "./audioClient";

export interface TextToMusicInputs {
  prompt: string;
  durationSeconds?: number;
}

export type GenerateMusicResult = { status: "success"; output_path: string } | { status: "error"; error: string };

export interface GenerateMusicContext {
  /** Base URL of the running musicgen_server.py subprocess. */
  audioBaseUrl: string;
  outputDir: string;
}

const DEFAULT_DURATION_SECONDS = 8;

/** The audio-engine half of generate() (spec §4.4) — no workflow graph needed, just prompt in, WAV out. */
export async function generateMusic(inputs: TextToMusicInputs, context: GenerateMusicContext): Promise<GenerateMusicResult> {
  try {
    await fs.mkdir(context.outputDir, { recursive: true });
    const outputPath = path.join(context.outputDir, buildOutputFilename("music", ".wav"));

    await generateAudio(context.audioBaseUrl, {
      prompt: inputs.prompt,
      durationSeconds: inputs.durationSeconds ?? DEFAULT_DURATION_SECONDS,
      outputPath
    });

    return { status: "success", output_path: outputPath };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}
