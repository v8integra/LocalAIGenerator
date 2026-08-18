import * as http from "http";
import { AddressInfo } from "net";

/**
 * Test-only HTTP server that serves a fixed buffer with Range-request
 * support, for exercising downloadFile()'s resume logic without touching
 * a real network endpoint.
 */
export class TestHttpServer {
  private server: http.Server;
  public requests: Array<{ range: string | undefined }> = [];
  public ignoreRange = false;
  public forceStatus: number | null = null;

  constructor(private body: Buffer) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const range = req.headers.range;
    this.requests.push({ range });

    if (this.forceStatus !== null) {
      res.writeHead(this.forceStatus);
      res.end();
      return;
    }

    if (range && !this.ignoreRange) {
      const match = /^bytes=(\d+)-$/.exec(range);
      const start = match ? Number(match[1]) : 0;

      if (start >= this.body.length) {
        res.writeHead(416, { "Content-Range": `bytes */${this.body.length}` });
        res.end();
        return;
      }

      const slice = this.body.subarray(start);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": slice.length,
        "Content-Range": `bytes ${start}-${this.body.length - 1}/${this.body.length}`,
        "Accept-Ranges": "bytes"
      });
      res.end(slice);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": this.body.length,
      "Accept-Ranges": "bytes"
    });
    res.end(this.body);
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }
}
