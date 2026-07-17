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
 * Behaviourally-rich fake `net.Socket` for the plain-TCP welcome probe.
 * Configurable to either:
 *   - emit a fabricated IS frame (welcome or other) once the consumer's
 *     `data` listener attaches, OR
 *   - emit `error` with a code, OR
 *   - silently never fire.
 *
 * Subclassing EventEmitter so `socket.on('data', cb)` / `.once('error', cb)`
 * etc. just work.
 *
 * Deliberately has no "replies with a bare ACK" mode. The probe never writes
 * to the socket: real hardware only ever accepts IS-framed commands, and then
 * only after a lock (verified in both the WF-3620 and XP-620 captures — every
 * host write begins with the `IS` magic, and `ESC @` appears only inside a
 * `0x2000` passthru). A fake that answers an unframed byte with a bare `0x06`
 * would model an exchange that has never occurred on the wire.
 */
class FakeNetSocket extends EventEmitter {
  destroyed = false;
  /** Every `data` chunk the probe was handed, for split-delivery assertions. */
  emittedChunks: Buffer[] = [];
  private behavior:
    | { kind: "welcome"; bytes: Buffer }
    /** Same frame, delivered as N separate `data` events (real TCP framing). */
    | { kind: "welcome-split"; chunks: Buffer[] }
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
        this.emittedChunks.push(this.behavior.bytes);
        this.emit("data", this.behavior.bytes);
      } else if (this.behavior.kind === "welcome-split") {
        // Separate ticks so each chunk is a distinct `data` event, as a
        // segmented frame would arrive off the wire.
        for (const chunk of this.behavior.chunks) {
          this.emittedChunks.push(chunk);
          this.emit("data", chunk);
        }
      }
      // "no-reply" intentionally never sends data → caller times out
    });
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * Build an `IS` welcome frame: 12-byte header, type=0x8000, payload size 5.
 * Payload shape matches real fixtures: `01 <discriminator> 00 00 00`.
 * The discriminator sits at payload[1] / frame offset 13 — verified against
 *   - `tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl`
 *     line 1: `49538000300c0000000500000104000000` (discriminator = 0x04)
 *   - `tools/pcap-extract/captures/wf-3620/*.jsonl` line 1
 *     (e.g. `adf-single-page-jpeg.jsonl`):
 *     `49538000300c0000000500000102000000` (discriminator = 0x02)
 */
function welcomeBytes(discriminator: number = 0x04): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x49;
  header[1] = 0x53;
  header.writeUInt16BE(0x8000, 2);
  header.writeUInt16BE(0x300c, 4);
  header.writeUInt32BE(5, 6);
  const payload = Buffer.from([0x01, discriminator, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, payload]);
}

/** Real fixture welcomes — load the literal first line from each pcap fixture
 * and feed THOSE bytes through the probe. Anchors the test to wire reality so
 * an off-by-one in `welcomeBytes()` (or in the probe) can't go undetected. */
const WF3620_REAL_WELCOME_HEX = "49538000300c0000000500000102000000";
const ET2750_REAL_WELCOME_HEX = "49538000300c0000000500000104000000";

/** Install a `net.connect` mock that hands out the given fakes in order.
 * Returns the spy so tests can assert how many plain-TCP connections the
 * probe opened — the welcome arm should need exactly one. */
function mockNetConnect(...fakes: FakeNetSocket[]) {
  let i = 0;
  return vi.spyOn(net, "connect").mockImplementation((..._args: unknown[]) => {
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

  it("returns esci when TLS fails and plain-TCP welcome carries the legacy discriminator (synthetic frame)", async () => {
    // Regression guard: a real WF-3620 / XP-620 emits an unsolicited 0x8000
    // welcome on plain TCP (every wf-3620 fixture under
    // tools/pcap-extract/captures/ begins with one). The welcome arm must
    // classify it as legacy ESC/I directly from the payload[1] discriminator
    // — positive evidence, no follow-up probe.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    const netSpy = mockNetConnect(
      new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes(0x02) }), // legacy shape
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.9",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
    // The welcome is sufficient — no second plain-TCP connection is opened.
    expect(netSpy).toHaveBeenCalledTimes(1);
  });

  it("returns esci when fed the actual WF-3620 fixture welcome bytes (wire-anchored regression)", async () => {
    // Strongest anchor: feed the literal first IS frame from a committed
    // WF-3620 pcap-extract fixture into the probe. If `welcomeBytes()` ever
    // drifts off by a byte (or the probe reads the wrong offset), this
    // test fails because synthetic and real shapes diverge.
    //
    // The XP-620 (issue #124) emits this byte-for-byte identical welcome, so
    // this also pins its classification.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    const netSpy = mockNetConnect(
      new FakeNetSocket({
        kind: "welcome",
        bytes: Buffer.from(WF3620_REAL_WELCOME_HEX, "hex"),
      }),
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.10",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
    expect(netSpy).toHaveBeenCalledTimes(1);
  });

  it("returns esci2-plain when fed the actual ET-2750 fixture welcome bytes (wire-anchored regression)", async () => {
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(
      new FakeNetSocket({
        kind: "welcome",
        bytes: Buffer.from(ET2750_REAL_WELCOME_HEX, "hex"),
      }),
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.11",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci2-plain");
  });

  it("returns esci when TLS fails and plain-TCP gives no welcome (inconclusive → fallback)", async () => {
    // A printer that neither speaks TLS nor announces itself leaves both arms
    // inconclusive. We still answer `esci` so the legacy scanner's connect
    // path runs and surfaces the real socket error — but only one plain-TCP
    // connection is attempted; there is no follow-up probe to fall through to.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    const netSpy = mockNetConnect(new FakeNetSocket({ kind: "no-reply" }));

    const variant = await detectVariant({
      printerIp: "10.0.0.3",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
    expect(netSpy).toHaveBeenCalledTimes(1);
  });

  it("does not log the all-probes-failed error when the welcome classifies as legacy", async () => {
    // The point of classifying from the welcome: a WF-3620 / XP-620 is
    // *positively* identified, so `auto` must not emit the alarming
    // "All probes failed" error on a printer it recognised correctly.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(
      new FakeNetSocket({
        kind: "welcome",
        bytes: Buffer.from(WF3620_REAL_WELCOME_HEX, "hex"),
      }),
    );

    const variant = await detectVariant({
      printerIp: "10.0.0.13",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("still logs the all-probes-failed error when nothing classifies", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ECONNREFUSED"));
    mockNetConnect(new FakeNetSocket({ kind: "error", code: "ECONNREFUSED" }));

    const variant = await detectVariant({
      printerIp: "10.0.0.14",
      port: 1865,
      override: "auto",
      timeoutMs: 30,
    });
    expect(variant).toBe("esci");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/All probes failed/);
  });

  it("returns esci as the safe fallback when every probe fails", async () => {
    // No probe classifies — detectVariant resolves to esci (the legacy
    // scanner's connect path will then surface the actual socket error).
    vi.spyOn(tls, "connect").mockReturnValue(tlsSilent());
    mockNetConnect(new FakeNetSocket({ kind: "no-reply" }));

    const variant = await detectVariant({
      printerIp: "10.0.0.5",
      port: 1865,
      override: "auto",
      timeoutMs: 30,
    });
    expect(variant).toBe("esci");
  });

  it("reassembles a welcome split across TCP segments (wire-anchored, legacy)", async () => {
    // The welcome is not guaranteed to arrive in one segment, and this family
    // demonstrably fragments IS frames: the WF-3620 capture shows a single IS
    // frame split as `49532100000c000000070000` + `01a0040000012c`. Split the
    // real welcome so the first chunk stops short of the discriminator — the
    // probe must accumulate rather than classify on the first chunk.
    const full = Buffer.from(WF3620_REAL_WELCOME_HEX, "hex");
    const first = full.subarray(0, 10); // 10 bytes: header incomplete
    const rest = full.subarray(10); // remainder carries payload[1]
    expect(first.length).toBeLessThan(14); // must not be classifiable alone

    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(new FakeNetSocket({ kind: "welcome-split", chunks: [first, rest] }));

    const variant = await detectVariant({
      printerIp: "10.0.0.15",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci");
  });

  it("reassembles a welcome split across TCP segments (wire-anchored, esci2-plain)", async () => {
    const full = Buffer.from(ET2750_REAL_WELCOME_HEX, "hex");
    // Split *inside* the discriminator's vicinity: 13 bytes leaves payload[1]
    // as the sole byte of the second chunk — the tightest boundary case.
    const first = full.subarray(0, 13);
    const rest = full.subarray(13);

    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(new FakeNetSocket({ kind: "welcome-split", chunks: [first, rest] }));

    const variant = await detectVariant({
      printerIp: "10.0.0.16",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci2-plain");
  });

  it("classifies an unknown non-legacy discriminator as esci2-plain (open-ended by design)", async () => {
    // The legacy marker is matched positively; everything else falls to
    // esci2-plain. A future ESC/I-2-class device emitting some third value at
    // payload[1] must still be accepted — this asymmetry is deliberate and
    // documented, so pin it. Inverting the ternary to key on 0x04 would break
    // this test and nothing else.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    mockNetConnect(new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes(0x07) }));

    const variant = await detectVariant({
      printerIp: "10.0.0.17",
      port: 1865,
      override: "auto",
      timeoutMs: 50,
    });
    expect(variant).toBe("esci2-plain");
  });

  it("rejects a non-welcome IS frame as inconclusive rather than classifying it", async () => {
    // Anything that isn't a 0x8000 welcome carries no family evidence.
    vi.spyOn(tls, "connect").mockReturnValue(tlsError("ERR_SSL_WRONG_VERSION_NUMBER"));
    const notAWelcome = welcomeBytes(0x04);
    notAWelcome.writeUInt16BE(0xa000, 2); // wrong IS type
    mockNetConnect(new FakeNetSocket({ kind: "welcome", bytes: notAWelcome }));

    const variant = await detectVariant({
      printerIp: "10.0.0.12",
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
    // The welcome arm opens one connection per call, so a cache hit would
    // show up as a single net.connect across both calls.
    expect(netSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT cache esci results (transient ECONNRESET could mislead)", async () => {
    const tlsSpy = vi.spyOn(tls, "connect").mockReturnValue(tlsError("ECONNRESET"));
    mockNetConnect(
      new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes(0x02) }),
      new FakeNetSocket({ kind: "welcome", bytes: welcomeBytes(0x02) }),
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
