import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as path from "path";

/** Stands in for musicgen_server.py in tests — same tiny JSON contract, no real torch/transformers needed. */
export class FakeAudioServer {
  private server: http.Server;
  public lastRequestBody: any = null;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET" && req.url === "/health") {
      this.sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && req.url === "/generate") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        this.lastRequestBody = body;

        if (body.prompt === "FORCE_ERROR") {
          this.sendJson(res, 500, { status: "error", error: "forced failure for testing" });
          return;
        }

        fs.mkdirSync(path.dirname(body.output_path), { recursive: true });
        fs.writeFileSync(body.output_path, Buffer.from("fake-wav-bytes"));
        this.sendJson(res, 200, { status: "success" });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    const { port: boundPort } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${boundPort}/`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}

if (require.main === module) {
  // CLI form: node fakeAudioServer.js <modelDir> <port> — mirrors
  // musicgen_server.py's own argv shape so orchestrator tests can spawn
  // this as a stand-in real subprocess via the same launch-command shape.
  const port = Number(process.argv[3]);
  const server = new FakeAudioServer();
  server.listen(port === 0 || Number.isNaN(port) ? 0 : port).then((url) => {
    console.log(`FAKE_AUDIO_READY ${url}`);
  });
}
