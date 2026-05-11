import { describe, it, expect } from "vitest";
import type { SessionTransport } from "../scan-session.js";
import { withEsci2UnlockOnDestroy, withTlsErrorLabels } from "./transport.js";
import { IS_HEADER_SIZE } from "../protocol.js";

describe("withEsci2UnlockOnDestroy wrapper", () => {
  // IS-header byte 2-3 carries packet type. LOCK is 0x2100, UNLOCK 0x2101 —
  // the wrapper sniffs writes by these bytes to track session state.
  function makeIsTypeStub(typeLo: number): Buffer {
    const buf = Buffer.alloc(IS_HEADER_SIZE);
    buf[2] = 0x21;
    buf[3] = typeLo;
    return buf;
  }
  const lockPacket = () => makeIsTypeStub(0x00);
  const unlockPacket = () => makeIsTypeStub(0x01);

  // Stub transport: records end()/destroy() invocations without doing any
  // real network work. Just enough surface for the wrapper.
  function makeStubTransport() {
    const calls: { end: number; destroy: number; endData: Buffer | null } = {
      end: 0,
      destroy: 0,
      endData: null,
    };
    const writes: Buffer[] = [];
    const stub: SessionTransport = {
      write(buf: Buffer) {
        writes.push(buf);
        return true;
      },
      end(data?: Buffer) {
        calls.end += 1;
        if (data) calls.endData = data;
      },
      destroy(_err?: Error) {
        calls.destroy += 1;
      },
      on() {
        return stub;
      },
    };
    return { transport: stub, calls, writes };
  }

  it("destroy() is a no-op after end() — preserves graceful TLS close_notify", () => {
    // Engine flow on healthy DONE: enterState(DONE) → transport.end()
    // (FIN), then settle → transport.destroy(). The wrapper must NOT
    // RST the socket on the second call, or TLS close_notify never
    // lands and the printer sees an unclean disconnect.
    const { transport, calls } = makeStubTransport();
    const wrapped = withEsci2UnlockOnDestroy(transport);
    wrapped.end();
    expect(calls.end).toBe(1);
    wrapped.destroy();
    expect(calls.destroy).toBe(0); // <-- the invariant
  });

  it("destroy() force-closes when LOCK was never sent (true error path, pre-LOCK)", () => {
    const { transport, calls } = makeStubTransport();
    const wrapped = withEsci2UnlockOnDestroy(transport);
    wrapped.destroy();
    expect(calls.destroy).toBe(1);
    expect(calls.end).toBe(0);
  });

  it("destroy() gracefully closes when both LOCK and UNLOCK landed (cleanup-state error)", () => {
    // Engine errored after UNLOCKING.onEnter wrote UNLOCK but before
    // the ack landed (timeout, validate fail, async fatal). The
    // application protocol close is already on the wire — graceful
    // TCP close preserves close_notify timing for the printer's
    // panel hygiene; a hard destroy reintroduces the panel errors
    // the wrapper is meant to prevent.
    const { transport, calls } = makeStubTransport();
    const wrapped = withEsci2UnlockOnDestroy(transport);
    wrapped.write(lockPacket());
    wrapped.write(unlockPacket());
    wrapped.destroy();
    expect(calls.destroy).toBe(0);
    expect(calls.end).toBe(1);
    expect(calls.endData).toBeNull(); // graceful close, no payload
  });

  it("destroy() sends UNLOCK via end(unlock) when LOCK was sent but UNLOCK wasn't", () => {
    // Engine errored mid-session after LOCK landed; wrapper sends the
    // UNLOCK record before half-closing.
    const { transport, calls } = makeStubTransport();
    const wrapped = withEsci2UnlockOnDestroy(transport);
    wrapped.write(lockPacket());
    wrapped.destroy();
    expect(calls.destroy).toBe(0);
    expect(calls.end).toBe(1);
    expect(calls.endData).not.toBeNull();
    expect(calls.endData?.[2]).toBe(0x21);
    expect(calls.endData?.[3]).toBe(0x01);
  });
});

describe("withTlsErrorLabels wrapper", () => {
  /**
   * Stub inner transport whose `error`-listener we can fire on demand.
   * Records writes / end / destroy so we can assert forwarding.
   */
  function makeStubTransport() {
    const calls: { end: number; destroy: number; endData: Buffer | null } = {
      end: 0,
      destroy: 0,
      endData: null,
    };
    let errorListener: ((...args: unknown[]) => void) | null = null;
    const stub: SessionTransport = {
      write() {
        return true;
      },
      end(data?: Buffer) {
        calls.end += 1;
        if (data) calls.endData = data;
      },
      destroy(_err?: Error) {
        calls.destroy += 1;
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "error") errorListener = cb;
        return stub;
      },
    };
    return {
      transport: stub,
      calls,
      fireError(err: Error & { code?: string }) {
        errorListener?.(err);
      },
    };
  }

  it("labels mid-session error messages with 'TLS connection error: <msg>'", () => {
    const { transport, fireError } = makeStubTransport();
    const wrapped = withTlsErrorLabels(transport);
    const seen: Error[] = [];
    wrapped.on("error", (err) => seen.push(err));
    fireError(new Error("EHOSTUNREACH"));
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("TLS connection error: EHOSTUNREACH");
  });

  it("swallows ECONNRESET / EPIPE after end() so a healthy DONE doesn't surface a benign post-FIN reset", () => {
    const { transport, fireError } = makeStubTransport();
    const wrapped = withTlsErrorLabels(transport);
    const seen: Error[] = [];
    wrapped.on("error", (err) => seen.push(err));
    wrapped.end();
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    fireError(reset);
    fireError(epipe);
    expect(seen).toHaveLength(0);
  });

  it("forwards end(data?) to inner — the unlock wrapper composes via end(data)", () => {
    const { transport, calls } = makeStubTransport();
    const wrapped = withTlsErrorLabels(transport);
    const payload = Buffer.from([0xab, 0xcd]);
    wrapped.end(payload);
    expect(calls.end).toBe(1);
    expect(calls.endData?.equals(payload)).toBe(true);
  });

  it("non-end-related errors after end() still forward (only ECONNRESET / EPIPE are benign)", () => {
    const { transport, fireError } = makeStubTransport();
    const wrapped = withTlsErrorLabels(transport);
    const seen: Error[] = [];
    wrapped.on("error", (err) => seen.push(err));
    wrapped.end();
    fireError(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("TLS connection error: EACCES");
  });
});

describe("withEsci2UnlockOnDestroy ∘ withTlsErrorLabels composition", () => {
  /**
   * Stub the leaf with both `end` capture (for unlock-on-abort assertions)
   * and an `error` listener slot (so we can assert error labels propagate
   * across the two layers).
   */
  function makeStubLeaf() {
    const calls: { end: number; destroy: number; endData: Buffer | null } = {
      end: 0,
      destroy: 0,
      endData: null,
    };
    let errorListener: ((...args: unknown[]) => void) | null = null;
    const stub: SessionTransport = {
      write() {
        return true;
      },
      end(data?: Buffer) {
        calls.end += 1;
        if (data) calls.endData = data;
      },
      destroy() {
        calls.destroy += 1;
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "error") errorListener = cb;
        return stub;
      },
    };
    return {
      leaf: stub,
      calls,
      fireError(err: Error & { code?: string }) {
        errorListener?.(err);
      },
    };
  }

  it("destroy() after mid-session LOCK still sends UNLOCK via the labeled wrapper's end(data)", () => {
    const { leaf, calls } = makeStubLeaf();
    const wrapped = withEsci2UnlockOnDestroy(withTlsErrorLabels(leaf));
    // Write a LOCK packet (IS type 0x2100) through the outer.
    const lock = Buffer.alloc(IS_HEADER_SIZE);
    lock[2] = 0x21;
    lock[3] = 0x00;
    wrapped.write(lock);
    // Destroy mid-session: outer routes through inner.end(unlockPacket).
    wrapped.destroy();
    expect(calls.destroy).toBe(0);
    expect(calls.end).toBe(1);
    expect(calls.endData?.[2]).toBe(0x21);
    expect(calls.endData?.[3]).toBe(0x01);
  });

  it("post-end ECONNRESET on the leaf is suppressed at the outer error listener", () => {
    const { leaf, fireError } = makeStubLeaf();
    const wrapped = withEsci2UnlockOnDestroy(withTlsErrorLabels(leaf));
    const seen: Error[] = [];
    wrapped.on("error", (err) => seen.push(err));
    // Polite close (engine reached DONE) — flows through both wrappers.
    wrapped.end();
    // Printer RSTs after our FIN — TLS-labels swallows.
    fireError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    expect(seen).toHaveLength(0);
  });
});
