import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import {
  createHealthServer,
  peerAddressOf,
  setLastScanTime,
  type HealthServerOptions,
} from "./health.js";

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

function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function listen(
  options?: HealthServerOptions,
): Promise<{ server: http.Server; base: string }> {
  const server = createHealthServer(0, options);
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
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

describe("POST /scan webhook", () => {
  let server: http.Server | undefined;
  const TOKEN = "correct-horse-battery-staple";
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  afterEach(() => {
    server?.close();
    server = undefined;
    setLastScanTime(null);
  });

  function enabled(overrides: Partial<NonNullable<HealthServerOptions["scanTrigger"]>> = {}) {
    const onScan = vi.fn();
    const scanTrigger = {
      token: TOKEN,
      defaults: { scanFormat: "pdf" as const, scanSides: "duplex" as const },
      isBusy: () => false,
      onScan,
      ...overrides,
    };
    return { scanTrigger, onScan };
  }

  it("is a plain 404 when no trigger is configured", async () => {
    const { server: s, base } = await listen();
    server = s;
    const res = await request("POST", `${base}/scan`, AUTH);
    expect(res.status).toBe(404);
  });

  it("keeps GET /health working when the trigger is enabled", async () => {
    const { scanTrigger } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("GET", `${base}/health`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("answers 405 with Allow: POST for a non-POST on /scan", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("GET", `${base}/scan`, AUTH);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(onScan).not.toHaveBeenCalled();
  });

  it("answers 401 without an Authorization header and does not dispatch", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan`);
    expect(res.status).toBe(401);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("answers 401 for a wrong token and does not dispatch", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan`, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("answers 400 for an invalid parameter and does not dispatch", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan?format=tiff`, AUTH);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("format");
    expect(onScan).not.toHaveBeenCalled();
  });

  it("answers 202 with the config defaults and dispatches once", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan`, AUTH);
    expect(res.status).toBe(202);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ status: "accepted", format: "pdf", sides: "duplex" });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan.mock.calls[0][0]).toEqual({ format: "pdf", sides: "duplex" });
    expect(onScan.mock.calls[0][1]).toBe("127.0.0.1");
  });

  it("echoes format/sides overrides in the 202 and the dispatch", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan?format=jpg&sides=simplex`, AUTH);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ status: "accepted", format: "jpg", sides: "simplex" });
    expect(onScan).toHaveBeenCalledWith({ format: "jpg", sides: "simplex" }, "127.0.0.1");
  });

  it("answers 409 while a scan is in flight and does not dispatch", async () => {
    const { scanTrigger, onScan } = enabled({ isBusy: () => true });
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/scan`, AUTH);
    expect(res.status).toBe(409);
    expect(onScan).not.toHaveBeenCalled();
  });

  it("ignores a request body rather than parsing it", async () => {
    const { scanTrigger, onScan } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request(
      "POST",
      `${base}/scan`,
      { ...AUTH, "Content-Type": "application/json" },
      JSON.stringify({ format: "jpg" }),
    );
    expect(res.status).toBe(202);
    expect(onScan).toHaveBeenCalledWith({ format: "pdf", sides: "duplex" }, "127.0.0.1");
  });

  it("returns 404 for unknown paths when the trigger is enabled", async () => {
    const { scanTrigger } = enabled();
    const { server: s, base } = await listen({ scanTrigger });
    server = s;
    const res = await request("POST", `${base}/other`, AUTH);
    expect(res.status).toBe(404);
  });
});

describe("malformed request paths", () => {
  let server: http.Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  function rawRequest(port: number, requestLine: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(port, "127.0.0.1", () => {
        client.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      client.on("data", (c) => (data += c.toString()));
      client.on("end", () => resolve(data));
      client.on("close", () => resolve(data));
      client.on("error", reject);
    });
  }

  it("answers a path the URL parser would reject instead of throwing (daemon must not exit)", async () => {
    const { server: s, base } = await listen();
    server = s;
    const port = Number(new URL(base).port);
    const uncaught = vi.fn();
    process.once("uncaughtException", uncaught);
    try {
      const response = await rawRequest(port, "GET //[/ HTTP/1.1");
      expect(response).toMatch(/^HTTP\/1\.1 404/);
      expect(uncaught).not.toHaveBeenCalled();
      // The server is still alive and serving.
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
    } finally {
      process.removeListener("uncaughtException", uncaught);
    }
  });

  it("routes /scan by path regardless of a hostile query string when enabled", async () => {
    const onScan = vi.fn();
    const { server: s, base } = await listen({
      scanTrigger: {
        token: "t",
        defaults: { scanFormat: "pdf", scanSides: "duplex" },
        isBusy: () => false,
        onScan,
      },
    });
    server = s;
    const res = await request("POST", `${base}/scan?%%%=[&format=jpg`, {
      Authorization: "Bearer t",
    });
    expect(res.status).toBe(202);
    expect(onScan).toHaveBeenCalledWith({ format: "jpg", sides: "duplex" }, "127.0.0.1");
  });
});

describe("peerAddressOf", () => {
  it("returns a plain IPv4 address unchanged", () => {
    expect(peerAddressOf("192.0.2.10")).toBe("192.0.2.10");
  });

  it("unmaps an IPv4-mapped IPv6 address (dual-stack listener, as on CI runners)", () => {
    expect(peerAddressOf("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(peerAddressOf("::FFFF:192.0.2.10")).toBe("192.0.2.10");
  });

  it("leaves a native IPv6 address alone", () => {
    expect(peerAddressOf("::1")).toBe("::1");
    expect(peerAddressOf("2001:db8::7")).toBe("2001:db8::7");
  });

  it("falls back to 'unknown' when the socket has no address", () => {
    expect(peerAddressOf(undefined)).toBe("unknown");
  });
});
