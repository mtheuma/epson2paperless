// src/scan-session.test.ts

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
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
});
