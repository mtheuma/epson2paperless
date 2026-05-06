// src/scan-session.test.ts

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGraph, decision, runScanSession } from "./scan-session.js";
import type { SessionTransport } from "./scan-session.js";
import { buildIsPacket } from "./protocol.js";

describe("createGraph", () => {
  it("builds an empty graph with the given initial state", () => {
    type Ctx = { count: number };
    const g = createGraph<Ctx>("START", 30_000);
    g.state("START", { on: {} });
    const graph = g.build();
    expect(graph.initial).toBe("START");
    expect(graph.timeoutMs).toBe(30_000);
    expect(graph.states.START).toBeDefined();
  });

  it("rejects building when initial state is undefined", () => {
    const g = createGraph<Record<string, never>>("START", 30_000);
    expect(() => g.build()).toThrow(/Initial state 'START' not defined/);
  });

  it("rejects duplicate state names", () => {
    const g = createGraph<Record<string, never>>("S", 30_000);
    g.state("S", { on: {} });
    expect(() => g.state("S", { on: {} })).toThrow(/Duplicate state/);
  });

  it('rejects defining the reserved "DONE" state', () => {
    const g = createGraph<Record<string, never>>("S", 30_000);
    expect(() => g.state("DONE", { on: {} })).toThrow(/"DONE" is reserved/);
  });
});

describe("decision", () => {
  it("wraps a function as a DecisionDef", () => {
    const def = decision<Record<string, never>>(() => ({ next: "NEXT" }));
    expect(def.__decision).toBe(true);
    const result = def.decide({}, { type: 0, payload: Buffer.alloc(0) });
    expect(result).toEqual({ next: "NEXT" });
  });
});

class FakeTransport extends EventEmitter implements SessionTransport {
  written: Buffer[] = [];
  destroyed = false;
  write(buf: Buffer): boolean {
    this.written.push(buf);
    return true;
  }
  end(): void {
    this.emit("close");
  }
  destroy(err?: Error): void {
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
  }
  // EventEmitter already implements `on` with the right structural shape.
}

describe("runScanSession (engine pump)", () => {
  it("dispatches a single static transition on receiving the expected IS packet", async () => {
    const transport = new FakeTransport();
    const factory = () => Promise.resolve(transport);
    type Ctx = { reached: boolean };
    const g = createGraph<Ctx>("WAITING", 1_000);
    g.state("WAITING", { on: { 0xa000: { next: "DONE" } } });
    // (DONE is reserved by the engine — do not call g.state("DONE", ...))

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: { reached: false },
      transportFactory: factory,
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true, // test-only — exercises engine scaffolding without a flushPage
    });

    // Simulate the printer sending a 0xa000 packet
    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("calls a decision function and follows its returned next state", async () => {
    const transport = new FakeTransport();
    type Ctx = { sourceByte: number | null };
    const g = createGraph<Ctx>("WAITING", 1_000);
    g.state(
      "WAITING",
      decision((ctx, packet) => {
        ctx.sourceByte = packet.payload[0];
        return { next: packet.payload[0] === 0x81 ? "FLATBED" : "ADF" };
      }),
    );
    g.state("FLATBED", { on: {} });
    g.state("ADF", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: { sourceByte: null },
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    setImmediate(() => {
      transport.emit("data", buildIsPacket(0xa200, Buffer.from([0x01]))); // ADF
      setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("settles { ok: false, reason } when a decision returns { error }", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state(
      "WAITING",
      decision(() => ({ error: new Error("boom") })),
    );

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa200, Buffer.from([0x01]))));

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toBe("boom");
  });

  it("fires onEnter when entering the initial state and sends its bytes", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WELCOME", 1_000);
    g.state("WELCOME", {
      on: { 0xa000: { next: "DONE" } },
      onEnter: () => Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    // Wait one microtask for transportFactory to resolve and onEnter to fire
    await new Promise((r) => setImmediate(r));
    expect(transport.written.length).toBe(1);
    expect(transport.written[0].equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(true);

    transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0)));
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("fires the rolling timeout if no packet arrives within timeoutMs", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 50); // 50ms timeout
    g.state("WAITING", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    // Don't send any data
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/Timeout in state WAITING/);
  });

  it("clears the rolling timeout when the expected packet arrives", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 50);
    g.state("WAITING", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    // Send before timeout
    setTimeout(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))), 20);

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("awaits flushPage.encode before sending the next command", async () => {
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));

    let encodeStartedAt = 0;
    let sendObservedAt = 0;
    const encodePromise = new Promise<Buffer>((resolve) => {
      setTimeout(() => {
        // Minimal valid JPEG: SOI + EOI
        resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }, 30);
    });

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          send: Buffer.from([0xca, 0xfe]),
          flushPage: {
            side: "front",
            encode: () => {
              encodeStartedAt = Date.now();
              return encodePromise;
            },
          },
        },
      },
    });

    // Wrap transport.write to record when our send was observed
    const origWrite = transport.write.bind(transport);
    transport.write = (buf: Buffer) => {
      if (buf.equals(Buffer.from([0xca, 0xfe]))) sendObservedAt = Date.now();
      return origWrite(buf);
    };

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: tempDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));

    const result = await promise;
    expect(result.ok).toBe(true);
    // The send must happen AFTER encode resolved
    expect(sendObservedAt).toBeGreaterThanOrEqual(encodeStartedAt + 30);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("buffers inbound data during a flushPage barrier and dispatches after resume", async () => {
    // Verifies: while flushPage is pending, the next packet from the printer is
    // buffered. Once flush resolves, that packet gets dispatched.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));

    const g = createGraph<{ pages: number }>("AWAIT_PAGE", 1_000);
    g.state("AWAIT_PAGE", {
      on: {
        0xa000: {
          next: "AFTER_FLUSH",
          flushPage: {
            side: "front",
            encode: async () => {
              await new Promise((r) => setTimeout(r, 30));
              return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
            },
          },
        },
      },
    });
    g.state("AFTER_FLUSH", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: { pages: 0 },
      transportFactory: () => Promise.resolve(transport),
      outputDir: tempDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    // First 0xa000 triggers flush; immediately after, send a SECOND 0xa000.
    // The second one should be buffered and dispatched only after flush resolves.
    setImmediate(() => {
      transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0)));
      transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0)));
    });

    const result = await promise;
    expect(result.ok).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
