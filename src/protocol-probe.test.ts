import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { detectVariant, resetCache } from "./protocol-probe.js";

/** Stub `tls.connect` that fires `secureConnect` on next-tick. */
function tlsHappyPath(): tls.TLSSocket {
  const sock = {
    destroy: vi.fn(),
    once: (ev: string, cb: () => void) => {
      if (ev === "secureConnect") setImmediate(cb);
      return sock;
    },
    on: () => sock,
    setTimeout: () => sock,
  };
  return sock as unknown as tls.TLSSocket;
}

/**
 * Stub `tls.connect` that fires `error` with the given code on next-tick
 * (for "TLS handshake refused, fall through to plain-TCP" tests).
 */
function tlsError(code: string): tls.TLSSocket {
  const sock = {
    destroy: vi.fn(),
    once: (ev: string, cb: (e: Error) => void) => {
      if (ev === "error") {
        setImmediate(() => {
          const err = new Error(code) as Error & { code?: string };
          err.code = code;
          cb(err);
        });
      }
      return sock;
    },
    on: () => sock,
    setTimeout: () => sock,
  };
  return sock as unknown as tls.TLSSocket;
}

/** Stub `tls.connect` whose handlers never fire — used for timeout tests. */
function tlsSilent(): tls.TLSSocket {
  return {
    destroy: vi.fn(),
    once: () => ({}) as tls.TLSSocket,
    on: () => ({}) as tls.TLSSocket,
    setTimeout: () => ({}) as tls.TLSSocket,
  } as unknown as tls.TLSSocket;
}

/**
 * Behaviourally-rich fake `net.Socket` for the plain-TCP probe arms.
 * Configurable to either:
 *   - emit a fabricated IS frame (welcome or other) once the consumer's
 *     `data` listener attaches, OR
 *   - emit `error` with a code, OR
 *   - silently never fire.
 *
 * Subclassing EventEmitter so `socket.on('data', cb)` / `.once('error', cb)`
 * etc. just work. The legacy probe also calls `socket.write` and reacts to
 * `"connect"` — both modeled below.
 */
class FakeNetSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];
  private behavior:
    | { kind: "welcome"; bytes: Buffer }
    | { kind: "ack"; bytes: Buffer }
    | { kind: "no-reply" }
    | { kind: "error"; code: string };

  constructor(behavior: FakeNetSocket["behavior"]) {
    super();
    this.behavior = behavior;
  }

  /** Called by the probe right after `net.connect` returns. */
  fireConnectAndBehavior(): void {
    setImmediate(() => {
      if (this.behavior.kind === "error") {
        const err = new Error(this.behavior.code) as Error & { code?: string };
        err.code = this.behavior.code;
        this.emit("error", err);
        return;
      }
      this.emit("connect");
      if (this.behavior.kind === "welcome") {
        this.emit("data", this.behavior.bytes);
      } else if (this.behavior.kind === "ack") {
        // Wait one more tick so the legacy probe's "send ESC @" fires
        // before we deliver the ACK — closer to real wire ordering.
        setImmediate(() =>
          this.emit("data", this.behavior.kind === "ack" ? this.behavior.bytes : Buffer.alloc(0)),
        );
      }
      // "no-reply" intentionally never sends data → caller times out
    });
  }

  override write(buf: Buffer): boolean {
    this.writes.push(Buffer.from(buf));
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * Build an `IS` welcome frame: 12-byte header, type=0x8000, payload size 5.
 * Payload shape matches real fixtures: `00 01 <discriminator> 00 00`.
 *   - `discriminator = 0x04` → ET-2750 (default, matches
 *     `tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl`).
 *   - `discriminator = 0x02` → WF-3620 (matches every capture in
 *     `tools/pcap-extract/captures/wf-3620/`).
 */
function welcomeBytes(discriminator: number = 0x04): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x49;
  header[1] = 0x53;
  header.writeUInt16BE(0x8000, 2);
  header.writeUInt16BE(0x300c, 4);
  header.writeUInt32BE(5, 6);
  const payload = Buffer.from([0x00, 0x01, discriminator, 0x00, 0x00]);
  return Buffer.concat([header, payload]);
}

/** Install a `net.connect` mock that hands out the given fakes in order. */
function mockNetConnect(...fakes: FakeNetSocket[]): void {
  let i = 0;
  vi.spyOn(net, "connect").mockImplementation((..._args: unknown[]) => {
    const fake = fakes[i++] ?? fakes[fakes.length - 1];
    fake.fireConnectAndBehavior();
    return fake as unknown as net.Socket;
  });
}

describe("protocol-probe", () => {
  beforeEach(() => {
    resetCache();
    vi.restoreAllMocks();
  });

  it("returns the explicit override without probing", async () => {
    const tlsSpy = vi.spyOn(tls, "connect");
    const netSpy = vi.spyOn(net, "connect");
    const variant = await detectVariant({
      printerIp: "10.0.0.1",
      port: 1865,
      override: "esci",
      timeoutMs: 100,
    });
    expect(variant).toBe("esci");
    expect(tlsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it("honours esci2-plain override without probing", async () => {
    const tlsSpy = vi.spyOn(tls, "connect");
    const netSpy = vi.spyOn(net, "connect");
    const variant = await detectVariant({
      printerIp: "10.0.0.1",
      port: 1865,
      override: "esci2-plain",
      timeoutMs: 100,
    });
    expect(variant).toBe("esci2-plain");
    expect(tlsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it("returns esci2 when the TLS handshake succeeds (auto)", async () => {
    vi.spyOn(tls, "connect").mockReturnValue(tlsHappyPath());

    const variant = await detectVariant({
      printerIp: "10.0.0.2",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(variant).toBe("esci2");
  });

  it("returns esci2-plain when TLS fails and plain-TCP welcomes with type=0x8000", async () => {
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes() }));

    const variant = await detectVariant({
      printerIp: "10.0.0.7",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(variant).toBe("esci2-plain");
  });

  it("returns esci when TLS fails and plain-TCP welcome carries the WF-3620 discriminator (payload[2]=0x02)", async () => {
    // Regression guard: a real WF-3620 emits an unsolicited 0x8000 welcome
    // on plain TCP (every wf-3620 fixture under tools/pcap-extract/captures/
    // begins with one). The plain-esci2 arm must reject it on the byte-2
    // discriminator and fall through to the legacy ESC @ probe.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(
      new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes(0x02) }), // WF-3620 shape
      new FakeNetSocket({ kind: "ack", bytes: Buffer.from([0x06]) }), // legacy probe ACKs
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.9",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
  });

  it("returns esci when TLS fails, plain-TCP gives no welcome, and ESC @ ACKs", async () => {
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(
      new FakeNetSocket({ kind: "no-reply" }), // plain-esci2 probe times out
      new FakeNetSocket({ kind: "ack", bytes: Buffer.from([0x06]) }), // legacy probe ACKs
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.3",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
  });

  it("returns esci as the safe fallback when every probe fails", async () => {
    // No probe classifies — detectVariant resolves to esci (the legacy
    // scanner's connect path will then surface the actual socket error).
    vi.spyOn(tls, "connect").mockReturnValue(tlsSilent());
    mockNetConnect(
      new FakeNetSocket({ kind: "no-reply" }),
      new FakeNetSocket({ kind: "no-reply" }),
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.5",
      port: 1865,
      override: "auto",
      timeoutMs: 30,
    });
    expect(variant).toBe("esci");
  });

  it("caches esci2 per-IP across multiple calls (positive evidence only)", async () => {
    const tlsSpy = vi.spyOn(tls, "connect").mockReturnValue(tlsHappyPath());

    await detectVariant({ printerIp: "10.0.0.4", port: 1865, override: "auto", timeoutMs: 100 });
    await detectVariant({ printerIp: "10.0.0.4", port: 1865, override: "auto", timeoutMs: 100 });
    expect(tlsSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache esci2-plain results (transient ECONNRESET could mislead)", async () => {
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    const netSpy = vi.spyOn(net, "connect").mockImplementation((..._args: unknown[]) => {
      const fake = new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes() });
      fake.fireConnectAndBehavior();
      return fake as unknown as net.Socket;
    });

    const a = await detectVariant({
      printerIp: "10.0.0.8",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    const b = await detectVariant({
      printerIp: "10.0.0.8",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(a).toBe("esci2-plain");
    expect(b).toBe("esci2-plain");
    // Probe ran on both calls (1 net.connect per probe arm × 2 arms × 2 calls = 4)
    // but net.connect was called more than once for sure — the cache wasn't hit.
    expect(netSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT cache esci results (transient ECONNRESET could mislead)", async () => {
    const tlsSpy = vi.spyOn(tls, "connect").mockReturnValue(tlsError("ECONNRESET"));
    mockNetConnect(
      new FakeNetSocket({ kind: "no-reply" }),
      new FakeNetSocket({ kind: "ack", bytes: Buffer.from([0x06]) }),
      new FakeNetSocket({ kind: "no-reply" }),
      new FakeNetSocket({ kind: "ack", bytes: Buffer.from([0x06]) }),
    );

    const a = await detectVariant({
      printerIp: "10.0.0.6",
      port: 1865,
      override: "auto",
      timeoutMs: 30,
    });
    const b = await detectVariant({
      printerIp: "10.0.0.6",
      port: 1865,
      override: "auto",
      timeoutMs: 30,
    });
    expect(a).toBe("esci");
    expect(b).toBe("esci");
    // TLS probe ran on both calls (2 calls).
    expect(tlsSpy).toHaveBeenCalledTimes(2);
  });
});
