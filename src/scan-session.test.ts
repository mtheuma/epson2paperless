// src/scan-session.test.ts

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGraph, decision, runScanSession } from "./scan-session.js";
import type { SessionTransport } from "./scan-session.js";
import { buildIsPacket } from "./protocol.js";

// Allow per-test spies on finalizeSession via vi.spyOn while keeping the
// default implementation (other tests rely on the real promote-and-write
// path producing scan_*.jpg files).
vi.mock("./output-tail.js", async () =>
  vi.importActual<typeof import("./output-tail.js")>("./output-tail.js"),
);

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
  destroyCallCount = 0;
  /**
   * Test hook: when set, end() throws this error. Used to verify the engine
   * tolerates a throwing transport.end() (e.g. real sockets can throw on
   * already-destroyed) without rerouting a valid scan into the failure path.
   */
  endThrowsOnce: Error | null = null;
  write(buf: Buffer): boolean {
    this.written.push(buf);
    return true;
  }
  end(): void {
    if (this.endThrowsOnce) {
      const err = this.endThrowsOnce;
      this.endThrowsOnce = null;
      throw err;
    }
    this.emit("close");
  }
  destroy(err?: Error): void {
    this.destroyCallCount += 1;
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

  it("injects EXIF Orientation=3 on back-side flushPage when action='jpg'", async () => {
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          flushPage: {
            side: "back",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
      // No allowZeroPages — there IS a flushPage in this run.
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);

    // finalizeSession promotes the temp page to outputDir as scan_*.jpg.
    // Verify the promoted file has the EXIF APP1 segment (bytes 2-3 = FF E1).
    const outputs = fs.readdirSync(outputDir);
    expect(outputs.length).toBe(1);
    const bytes = fs.readFileSync(path.join(outputDir, outputs[0]));
    // Bytes 2-3 of the EXIF-injected output are FF E1 (APP1 marker).
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xe1);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("rejects with 'zero image chunks' when DONE is reached without any flushPage (production path)", async () => {
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    // Graph reaches DONE without flushing a page. Production callers must NOT
    // set allowZeroPages — note its absence below.
    const g = createGraph<Record<string, never>>("WAIT", 1_000);
    g.state("WAIT", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
      // allowZeroPages: NOT set — engine should reject.
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/zero image chunks/);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("calls finalizeSession on reaching DONE — produces a JPG in outputDir", async () => {
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
      // No allowZeroPages — and that's fine because there IS a flushPage in this run.
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);

    // Output dir should contain a scan_*.jpg promoted by finalizeSession.
    const outputs = fs.readdirSync(outputDir);
    expect(outputs.some((f) => /^scan_.*\.jpg$/.test(f))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("post-scan-save fallback: failure after flushPage still finalizes captured pages and resolves ok", async () => {
    // Mirrors v0.3.0 §3.3 contract: once pages have flushed to the temp
    // dir, panel-hygiene errors in cleanup states (UNLOCK ack timeout,
    // unexpected close, async fatal event, etc.) shouldn't discard the
    // scan the user already got out of the printer.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    // PAGE flushes a page on the first packet, then advances to CLEANUP.
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "CLEANUP",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });
    // CLEANUP fails on the next packet — simulates a post-image cleanup
    // error (e.g. UNLOCK validation NAK, async fatal during drain).
    g.state("CLEANUP", {
      ...decision(() => ({ error: new Error("cleanup glitch after flush") })),
    });
    g.cleanupStates(["CLEANUP"]);

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    // Both packets in one chunk: tryParseHead handles multi-packet buffers,
    // and the engine's pump loop picks up packet 2 from recvChunks after
    // the flushPage barrier resolves. Reentrancy + recvChunks buffering
    // make a hand-tuned tick budget unnecessary.
    setImmediate(() =>
      transport.emit(
        "data",
        Buffer.concat([
          buildIsPacket(0xa000, Buffer.alloc(0)),
          buildIsPacket(0xa000, Buffer.alloc(0)),
        ]),
      ),
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    const outputs = fs.readdirSync(outputDir);
    expect(outputs.some((f) => /^scan_.*\.jpg$/.test(f))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("post-scan-save fallback skipped when failure is in a non-cleanup state (mid-multi-page acquisition)", async () => {
    // Models a 3-page scan that fatals while waiting for page 2: page 1
    // is already flushed, but the failing state is image-acquisition,
    // not cleanup. We must NOT silently treat partial output as success.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("IMG_META_1", 1_000);
    // IMG_META_1: flush page 1, then advance to IMG_META_2 (still in
    // image-acquisition territory).
    g.state("IMG_META_1", {
      on: {
        0xa000: {
          next: "IMG_META_2",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });
    // IMG_META_2: simulates the fatal during page-2 acquisition. Not
    // declared as a cleanup state.
    g.state("IMG_META_2", {
      ...decision(() => ({ error: new Error("printer fatal mid-page-2") })),
    });
    // Declare IMG_META_1 as the only "cleanup" state — but the failure
    // happens in IMG_META_2, so the predicate is false at settle time.
    // (Using IMG_META_1 here just to satisfy the build-time "cleanup
    // references defined state" check; the test still proves the
    // predicate gates correctly.)
    g.cleanupStates(["IMG_META_1"]);

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() =>
      transport.emit(
        "data",
        Buffer.concat([
          buildIsPacket(0xa000, Buffer.alloc(0)),
          buildIsPacket(0xa000, Buffer.alloc(0)),
        ]),
      ),
    );

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/printer fatal mid-page-2/);
    // outputDir must remain empty — partial multi-page output isn't promoted.
    expect(fs.readdirSync(outputDir).length).toBe(0);
    // Engine must rm sessionTempDir on non-cleanup failures so flushed
    // page_NN.jpg files don't outlive the session under tempBase.
    const leftoverSessionDirs = fs
      .readdirSync(tempDir)
      .filter((entry) => entry.startsWith("epson2paperless-"));
    expect(leftoverSessionDirs).toEqual([]);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("post-scan-save fallback skipped when zero pages flushed", async () => {
    // The opposite half of the contract: failures BEFORE any flushPage
    // surface as { ok: false } unchanged. No promotion is attempted —
    // there's nothing to promote.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("WAIT", 1_000);
    g.state("WAIT", {
      ...decision(() => ({ error: new Error("init failed before any image") })),
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/init failed before any image/);
    expect(fs.readdirSync(outputDir).length).toBe(0);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("resolves a (ctx) => Buffer send at dispatch time using current ctx", async () => {
    const transport = new FakeTransport();
    type Ctx = { token: number };
    const g = createGraph<Ctx>("WAITING", 1_000);
    g.state("WAITING", {
      on: {
        0xa000: {
          next: "DONE",
          send: (ctx) => Buffer.from([ctx.token]),
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: { token: 0x42 },
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);

    // Among transport.written, find a buffer with byte 0x42
    expect(transport.written.some((b) => b.length === 1 && b[0] === 0x42)).toBe(true);
  });

  it("supports a decision state with onEnter (sends bytes before deciding)", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state("WAITING", {
      ...decision(() => ({ next: "DONE" })),
      onEnter: () => Buffer.from([0xff]),
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

    await new Promise((r) => setImmediate(r));
    expect(transport.written.some((b) => b.length === 1 && b[0] === 0xff)).toBe(true);

    setImmediate(() => transport.emit("data", buildIsPacket(0xa200, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("calls a global abort handler that returns Error and fails the session", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000).globalAbortHandlers({
      0x9000: () => new Error("simulated async fatal"),
    });
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

    setImmediate(() => transport.emit("data", buildIsPacket(0x9000, Buffer.from([0x02]))));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/simulated async fatal/);
  });

  it("calls a global abort handler that returns null and continues dispatch", async () => {
    const transport = new FakeTransport();
    let infoSeen = false;
    const g = createGraph<Record<string, never>>("WAITING", 1_000).globalAbortHandlers({
      0x9000: () => {
        infoSeen = true;
        return null; // info-only — no abort
      },
    });
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

    // First send a 0x9000 info event (should be consumed by the handler, not advance state).
    // Then send 0xa000 to advance to DONE.
    setImmediate(() => {
      transport.emit("data", buildIsPacket(0x9000, Buffer.from([0x01])));
      setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(infoSeen).toBe(true);
  });

  it("passes currentState to globalIgnoreFilter so it can scope itself per state", async () => {
    // The filter bypasses itself in state DRAIN (drain-complete reply
    // has the same wire shape as the wait-for-body signal in WAIT). The
    // engine must thread currentState through, otherwise the filter
    // can't distinguish and either over- or under-filters.
    const transport = new FakeTransport();
    const observed: { state: string; payloadLen: number }[] = [];
    const g = createGraph<Record<string, never>>("WAIT", 1_000).globalIgnoreFilter(
      (packet, currentState) => {
        observed.push({ state: currentState, payloadLen: packet.payload.length });
        if (currentState === "DRAIN") return false;
        return packet.type === 0xa000 && packet.payload.length === 0;
      },
    );
    g.state("WAIT", { on: { 0xa000: { next: "DRAIN" } } });
    g.state("DRAIN", { on: { 0xa000: { next: "DONE" } } });

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

    setImmediate(() => {
      // First packet (non-empty in WAIT) → not filtered, advances to DRAIN.
      transport.emit("data", buildIsPacket(0xa000, Buffer.from([0xab])));
      // Second packet (empty in DRAIN) — filter bypasses itself, advances to DONE.
      setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    // Filter saw both packets with their respective states.
    expect(observed).toEqual([
      { state: "WAIT", payloadLen: 1 },
      { state: "DRAIN", payloadLen: 0 },
    ]);
  });

  it("silently discards packets matched by globalIgnoreFilter", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000).globalIgnoreFilter(
      // Filter out empty 0xa000 envelopes (simulates the ESC/I-2 wait-for-body pattern).
      (packet) => packet.type === 0xa000 && packet.payload.length === 0,
    );
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

    setImmediate(() => {
      // Empty 0xa000 — filter discards; state does NOT advance.
      transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0)));
      // Non-empty 0xa000 — passes the filter; state advances to DONE.
      setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.from([0xab]))));
    });

    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it("fails the session when a transition's validate returns false", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state("WAITING", {
      on: {
        0x2000: {
          // Simulates the ESC/I "ACK is 0x06 byte 0 of 0x2000 envelope" pattern.
          validate: (payload) => payload[0] === 0x06,
          next: "DONE",
        },
      },
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

    // Send a 0x2000 packet whose payload[0] is NOT 0x06 — validate fails.
    setImmediate(() => transport.emit("data", buildIsPacket(0x2000, Buffer.from([0x15]))));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.message).toMatch(/Validation failed in state WAITING/);
      expect(result.reason.message).toMatch(/0x2000/);
    }
  });

  it("writes multi-buffer send arrays in order", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state("WAITING", {
      on: {
        0xa000: {
          next: "DONE",
          send: [Buffer.from([0xaa]), Buffer.from([0xbb]), Buffer.from([0xcc])],
        },
      },
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

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);

    // The transport.written array should contain three buffers in order: 0xaa, 0xbb, 0xcc.
    // (There may also be other writes from session setup; filter to single-byte writes.)
    const singleByteWrites = transport.written.filter((b) => b.length === 1).map((b) => b[0]);
    expect(singleByteWrites).toEqual([0xaa, 0xbb, 0xcc]);
  });

  // Fix 1: DONE no longer waits for transport close to settle the promise.
  it("settles after DONE without waiting for transport close", async () => {
    // FakeTransport.end() normally emits "close" synchronously. Override it
    // to be a no-op to simulate a peer that never ACKs our FIN.
    const transport = new FakeTransport();
    transport.end = () => {
      /* swallow — peer never closes */
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // Regression: enterState("DONE") must clear the timeout armed by the prior
  // state. Otherwise on a non-flushPage final transition (e.g. UNLOCKING →
  // DONE in the ESC/I-2 graph) the leftover timer fires "Timeout in state
  // DONE" mid-finalize, racing settle and rm-ing the temp dir while
  // finalizeSession is still reading from it.
  it("clears prior-state timeout when entering DONE so a slow finalize doesn't race a leftover timer", async () => {
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const outputTail = await import("./output-tail.js");
    const realFinalize = outputTail.finalizeSession;
    const spy = vi.spyOn(outputTail, "finalizeSession").mockImplementation(async (opts) => {
      // Hold finalize past the prior-state timeout so a leftover timer
      // would have fired by the time we resolve.
      await new Promise((r) => setTimeout(r, 80));
      await realFinalize(opts);
    });

    // PAGE flushes (barrier clears + re-arms timer). INTER → DONE has no
    // flushPage; DONE entry is the place that must clear INTER's timer.
    const g = createGraph<Record<string, never>>("PAGE", 20);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "INTER",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });
    g.state("INTER", { on: { 0xa000: { next: "DONE" } } });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() =>
      transport.emit(
        "data",
        Buffer.concat([
          buildIsPacket(0xa000, Buffer.alloc(0)),
          buildIsPacket(0xa000, Buffer.alloc(0)),
        ]),
      ),
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.reason.message).not.toMatch(/Timeout/);
    }
    // outputDir should contain a scan_*.jpg promoted by finalizeSession.
    const outputs = fs.readdirSync(outputDir);
    expect(outputs.some((f) => /^scan_.*\.jpg$/.test(f))).toBe(true);

    spy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // Fix 2: Pump stops dispatching after an error settle.
  it("stops the pump after an error settle even if more packets are buffered", async () => {
    const transport = new FakeTransport();
    let secondPacketDispatched = false;
    const g = createGraph<Record<string, never>>("WAITING", 1_000).globalAbortHandlers({
      0x9000: () => new Error("first packet aborts"),
    });
    g.state("WAITING", {
      on: {
        0xa000: {
          next: "WAITING",
          validate: (_payload) => {
            // If the second packet is dispatched, this validator runs.
            secondPacketDispatched = true;
            return true;
          },
        },
      },
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

    // Two packets in one tick: first triggers globalAbort error settle,
    // second is buffered. The pump must NOT dispatch the second.
    setImmediate(() => {
      transport.emit("data", buildIsPacket(0x9000, Buffer.from([0x02])));
      transport.emit("data", buildIsPacket(0xa000, Buffer.from([0x06])));
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/first packet aborts/);
    expect(secondPacketDispatched).toBe(false);
  });

  // Fix 3: Hook exceptions route through settle as { ok: false }.
  it("settles { ok: false } when a hook throws synchronously", async () => {
    const transport = new FakeTransport();
    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state(
      "WAITING",
      decision(() => {
        throw new Error("bad payload parse");
      }),
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

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.message).toMatch(/Engine error in state WAITING/);
      expect(result.reason.message).toMatch(/bad payload parse/);
    }
  });

  // ---------------------------------------------------------------------------
  // PR 1 lifecycle hardening regression suite
  // ---------------------------------------------------------------------------

  it("clean DONE success skips transport.destroy() (polite end already issued)", async () => {
    // Regression: prior to PR 1, settle() unconditionally called destroy()
    // even after enterState("DONE") had already issued a polite end(). That
    // forced adapters to special-case "we already closed." Now: natural-DONE
    // success skips destroy; only failure paths (and the cleanupStates
    // recovery's prior abort settle) destroy.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(transport.destroyCallCount).toBe(0);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("cleanupStates recovery still destroys the transport (abort settle ran first), then resolves ok", async () => {
    // Companion to the previous test. The cleanupStates fallback path
    // bypasses settle for its ok-resolution (it resolve()s the promise
    // directly inside an IIFE), but it has *already* gone through a prior
    // settle({ ok: false }) — which destroys. So a recovered scan still
    // tears down the transport correctly, even though the final result
    // is { ok: true }.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "CLEANUP",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });
    g.state("CLEANUP", {
      ...decision(() => ({ error: new Error("cleanup glitch after flush") })),
    });
    g.cleanupStates(["CLEANUP"]);

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() =>
      transport.emit(
        "data",
        Buffer.concat([
          buildIsPacket(0xa000, Buffer.alloc(0)),
          buildIsPacket(0xa000, Buffer.alloc(0)),
        ]),
      ),
    );

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(transport.destroyCallCount).toBeGreaterThanOrEqual(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("tolerates synchronous data replay during transport.on('data', ...) registration", async () => {
    // Pre-fix behaviour: `let dispatching` was declared after the data
    // listener was registered, so a synchronous-during-registration replay
    // would TDZ when the resulting tryDispatch read `dispatching`. Then,
    // even with `dispatching` hoisted, dispatch would crash on a
    // graph.states[""] lookup because enterState(graph.initial) hadn't
    // run yet. Then, even with the empty-state gate, the chunk would sit
    // in recvChunks forever because nothing scheduled tryDispatch after
    // initial entry. All three fixes are required for this test to pass.
    class SyncReplayFakeTransport extends EventEmitter implements SessionTransport {
      pending: Buffer[] = [];
      written: Buffer[] = [];
      destroyCallCount = 0;
      write(buf: Buffer): boolean {
        this.written.push(buf);
        return true;
      }
      end(): void {
        this.emit("close");
      }
      destroy(): void {
        this.destroyCallCount += 1;
        this.emit("close");
      }
      override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
        const wasFirst = this.listenerCount(event) === 0;
        super.on(event, listener);
        if (event === "data" && wasFirst && this.pending.length > 0) {
          // Synchronously replay each queued chunk during the on() call —
          // before it returns. Real Node sockets don't do this, but this is
          // the contract the engine should be robust to.
          const queue = this.pending.splice(0);
          for (const chunk of queue) listener(chunk);
        }
        return this;
      }
    }

    const transport = new SyncReplayFakeTransport();
    // Queue the trigger packet *before* runScanSession registers its data
    // listener, so the .on("data", cb) call in runScanSession synchronously
    // replays the chunk before returning.
    transport.pending.push(buildIsPacket(0xa000, Buffer.alloc(0)));

    const g = createGraph<Record<string, never>>("WAITING", 1_000);
    g.state("WAITING", { on: { 0xa000: { next: "DONE" } } });

    const result = await runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir: "/tmp",
      tempDir: "/tmp",
      sessionTs: new Date(),
      action: "jpg",
      allowZeroPages: true,
    });

    expect(result.ok).toBe(true);
  });

  it("keeps a valid scan ok when transport.end() throws on DONE entry", async () => {
    // Regression: prior to PR 1, a throw from transport.end() inside
    // enterState("DONE") propagated up through applyTransition into
    // tryDispatch's catch, which routed through settle({ ok: false }) —
    // misclassifying a successful scan (all pages flushed, finalize would
    // have succeeded) as a failure. Post-fix the throw is swallowed and
    // doFinalize runs normally.
    const transport = new FakeTransport();
    transport.endThrowsOnce = new Error("simulated already-destroyed throw");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-out-"));

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "DONE",
          flushPage: {
            side: "front",
            encode: () => Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          },
        },
      },
    });

    const promise = runScanSession({
      graph: g.build(),
      initialCtx: {},
      transportFactory: () => Promise.resolve(transport),
      outputDir,
      tempDir,
      sessionTs: new Date(),
      action: "jpg",
    });

    setImmediate(() => transport.emit("data", buildIsPacket(0xa000, Buffer.alloc(0))));

    const result = await promise;
    expect(result.ok).toBe(true);
    // Clean-DONE-skip-destroy contract still applies — even though end()
    // threw, the engine treats DONE as a clean exit and doesn't escalate
    // to destroy.
    expect(transport.destroyCallCount).toBe(0);
    const outputs = fs.readdirSync(outputDir);
    expect(outputs.some((f) => /^scan_.*\.jpg$/.test(f))).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("settles cleanly when 'close' arrives during a flushPage barrier (no double-settle, no post-settle writes)", async () => {
    // While encode is pending, the transport closes unexpectedly. The
    // engine's barrier code re-checks `settled` after each await before
    // performing any side-effect (file write, staged send, ctx mutation,
    // entering the staged next state).
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));

    let resolveEncode: ((bytes: Buffer) => void) | null = null;
    const encodePromise = new Promise<Buffer>((r) => {
      resolveEncode = r;
    });
    const settleSpyWrites: Buffer[] = [];

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "AFTER",
          send: Buffer.from([0xca, 0xfe]), // staged send — must NOT fire post-close
          flushPage: { side: "front", encode: () => encodePromise },
        },
      },
    });
    g.state("AFTER", { on: {} });

    // Wrap write to catch any post-close staged-send leak.
    const origWrite = transport.write.bind(transport);
    transport.write = (buf: Buffer) => {
      settleSpyWrites.push(buf);
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

    // Wait long enough for the barrier to start, then close the transport
    // mid-encode and let encode resolve.
    await new Promise((r) => setTimeout(r, 20));
    transport.emit("close");
    await new Promise((r) => setTimeout(r, 5));
    resolveEncode!(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/closed unexpectedly/);
    // Staged send (0xca 0xfe) must NOT have been written post-settle.
    expect(settleSpyWrites.some((b) => b.equals(Buffer.from([0xca, 0xfe])))).toBe(false);
    // Close path destroys the transport.
    expect(transport.destroyCallCount).toBeGreaterThanOrEqual(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("settles cleanly when 'error' arrives during a flushPage barrier", async () => {
    // Mirror of the close-mid-barrier test, but with an error event. Same
    // settled-recheck contract applies.
    const transport = new FakeTransport();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-test-"));

    let resolveEncode: ((bytes: Buffer) => void) | null = null;
    const encodePromise = new Promise<Buffer>((r) => {
      resolveEncode = r;
    });
    const stagedSendObserved: Buffer[] = [];

    const g = createGraph<Record<string, never>>("PAGE", 1_000);
    g.state("PAGE", {
      on: {
        0xa000: {
          next: "AFTER",
          send: Buffer.from([0xde, 0xad]),
          flushPage: { side: "front", encode: () => encodePromise },
        },
      },
    });
    g.state("AFTER", { on: {} });

    const origWrite = transport.write.bind(transport);
    transport.write = (buf: Buffer) => {
      stagedSendObserved.push(buf);
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

    await new Promise((r) => setTimeout(r, 20));
    transport.emit("error", new Error("network blip mid-encode"));
    await new Promise((r) => setTimeout(r, 5));
    resolveEncode!(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.message).toMatch(/network blip mid-encode/);
    expect(stagedSendObserved.some((b) => b.equals(Buffer.from([0xde, 0xad])))).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
