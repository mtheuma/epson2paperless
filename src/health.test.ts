import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createHealthServer, setLastScanTime } from "./health.js";

function fetch(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}

describe("health server", () => {
  let server: http.Server;

  afterEach(() => {
    server?.close();
  });

  it("responds 200 with JSON status on GET /health", async () => {
    server = createHealthServer(0); // port 0 = random available port
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe("ok");
    expect(json.lastScan).toBeNull();
  });

  it("includes lastScan timestamp when set", async () => {
    const time = "2026-04-16T14:30:22.000Z";
    setLastScanTime(time);

    server = createHealthServer(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    const json = JSON.parse(res.body);
    expect(json.lastScan).toBe(time);

    // Reset for other tests
    setLastScanTime(null);
  });

  it("responds 404 for other paths", async () => {
    server = createHealthServer(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${addr.port}/other`);
    expect(res.status).toBe(404);
  });
});
