import * as crypto from "crypto";
import * as http from "http";
import { AddressInfo } from "net";

interface HistoryEntry {
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }>; gifs?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status: { status_str: "success" | "error"; completed: boolean; messages: string[] };
}

/**
 * Stands in for a real ComfyUI server in tests. Implements just enough of
 * the verified API contract (POST /prompt, GET /history/{id}, GET /view,
 * GET /system_stats) to exercise comfyClient/generate without needing a
 * real ComfyUI + torch/CUDA install. A workflow whose positive prompt text
 * is exactly "FORCE_ERROR" completes with status_str "error", so failure
 * handling can be tested too.
 */
export class FakeComfyServer {
  private server: http.Server;
  private history = new Map<string, HistoryEntry>();
  public completionDelayMs = 20;
  public fakeImageBytes = Buffer.from("fake-png-bytes");
  public lastReceivedWorkflow: Record<string, unknown> | null = null;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/system_stats") {
      this.sendJson(res, 200, { system: { comfyui_version: "fake" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/prompt") {
      this.handlePrompt(req, res);
      return;
    }

    const historyMatch = /^\/history\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && historyMatch) {
      const promptId = historyMatch[1];
      const entry = this.history.get(promptId);
      this.sendJson(res, 200, entry ? { [promptId]: entry } : {});
      return;
    }

    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": this.fakeImageBytes.length });
      res.end(this.fakeImageBytes);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handlePrompt(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      this.lastReceivedWorkflow = body.prompt;

      if (promptContainsText(body.prompt, "FORCE_INVALID_PROMPT")) {
        this.sendJson(res, 400, { error: { message: "forced validation rejection for testing" }, node_errors: {} });
        return;
      }

      const promptId = crypto.randomUUID();
      const shouldFail = promptContainsText(body.prompt, "FORCE_ERROR");

      this.sendJson(res, 200, { prompt_id: promptId, number: 1, node_errors: {} });

      setTimeout(() => {
        this.history.set(promptId, shouldFail ? this.errorEntry() : this.successEntry(body.prompt));
      }, this.completionDelayMs);
    });
  }

  private successEntry(workflow: Record<string, any>): HistoryEntry {
    const videoNodeId = Object.keys(workflow ?? {}).find((id) => workflow[id]?.class_type === "VHS_VideoCombine");

    if (videoNodeId) {
      return {
        outputs: {
          [videoNodeId]: { gifs: [{ filename: "fake_output_00001_.gif", subfolder: "", type: "output" }] }
        },
        status: { status_str: "success", completed: true, messages: [] }
      };
    }

    return {
      outputs: {
        "9": { images: [{ filename: "fake_output_00001_.png", subfolder: "", type: "output" }] }
      },
      status: { status_str: "success", completed: true, messages: [] }
    };
  }

  private errorEntry(): HistoryEntry {
    return {
      outputs: {},
      status: { status_str: "error", completed: true, messages: ["forced failure for testing"] }
    };
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  async listen(port = 0): Promise<{ url: string; port: number }> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}/`, port: address.port };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}

function promptContainsText(workflow: Record<string, any>, text: string): boolean {
  return Object.values(workflow ?? {}).some(
    (node: any) => node?.class_type === "CLIPTextEncode" && node?.inputs?.text === text
  );
}

if (require.main === module) {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : 0;
  const server = new FakeComfyServer();
  server.listen(port).then(({ port: boundPort }) => {
    // Signals readiness to a parent process spawning this as a fixture.
    console.log(`FAKE_COMFY_READY port=${boundPort}`);
  });
}
