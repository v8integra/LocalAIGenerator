export interface QueuePromptResult {
  promptId: string;
  nodeErrors: Record<string, unknown>;
}

/** Submits a workflow graph for execution (spec §4.4: talks to ComfyUI only over HTTP). */
export async function queuePrompt(
  baseUrl: string,
  workflow: Record<string, unknown>,
  clientId: string
): Promise<QueuePromptResult> {
  const response = await fetch(new URL("/prompt", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });

  const body = await response.json();

  if (!response.ok) {
    const message =
      typeof body.error === "string" ? body.error : (body.error?.message ?? JSON.stringify(body.error));
    throw new Error(`ComfyUI rejected the prompt: ${message}`);
  }

  return { promptId: body.prompt_id, nodeErrors: body.node_errors ?? {} };
}

export interface HistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryStatus {
  statusStr: "success" | "error";
  completed: boolean;
  messages: string[];
}

export interface HistoryEntry {
  /** images: SaveImage's output key; gifs: VHS_VideoCombine's; audio: SaveAudio's — all fetch identically via /view. */
  outputs: Record<string, { images?: HistoryImage[]; gifs?: HistoryImage[]; audio?: HistoryImage[] }>;
  status: HistoryStatus | null;
}

/** Returns null while the prompt is still queued/running — ComfyUI's /history omits it until done. */
export async function getHistory(baseUrl: string, promptId: string): Promise<HistoryEntry | null> {
  const response = await fetch(new URL(`/history/${promptId}`, baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to fetch history for prompt ${promptId}: HTTP ${response.status}`);
  }

  const body = await response.json();
  const entry = body[promptId];
  if (!entry) return null;

  return {
    outputs: entry.outputs ?? {},
    status: entry.status
      ? {
          statusStr: entry.status.status_str,
          completed: entry.status.completed,
          messages: entry.status.messages ?? []
        }
      : null
  };
}

export interface WaitForCompletionOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * Polls until the prompt is marked completed, regardless of whether it
 * succeeded or failed — interpreting status_str is the caller's job, this
 * just waits for a final answer.
 */
export async function waitForCompletion(
  baseUrl: string,
  promptId: string,
  options: WaitForCompletionOptions = {}
): Promise<HistoryEntry> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const entry = await getHistory(baseUrl, promptId);
    if (entry?.status?.completed) {
      return entry;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for prompt ${promptId} to complete`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Downloads a generated output's bytes via ComfyUI's /view endpoint. */
export async function fetchImage(baseUrl: string, image: HistoryImage): Promise<Buffer> {
  const url = new URL("/view", baseUrl);
  url.searchParams.set("filename", image.filename);
  url.searchParams.set("subfolder", image.subfolder);
  url.searchParams.set("type", image.type);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch output image "${image.filename}": HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
