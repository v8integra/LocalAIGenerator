export interface GenerateAudioParams {
  prompt: string;
  durationSeconds: number;
  outputPath: string;
}

/** Talks to musicgen_server.py's /generate endpoint — one request per generation, no queue/history polling needed (unlike ComfyUI). */
export async function generateAudio(baseUrl: string, params: GenerateAudioParams): Promise<void> {
  const response = await fetch(new URL("/generate", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: params.prompt,
      duration_seconds: params.durationSeconds,
      output_path: params.outputPath
    })
  });

  const body = await response.json();

  if (!response.ok || body.status !== "success") {
    const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`Audio generation failed: ${message}`);
  }
}
