import { describe, it, expect } from "vitest";
import type * as tls from "node:tls";
import { withEsci2UnlockOnDestroy } from "./transport.js";
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

  // Stub socket: records end()/destroy() invocations without actually
  // doing TLS / network work. Just enough surface for the wrapper.
  function makeStubSocket() {
    const calls: { end: number; destroy: number; endData: Buffer | null } = {
      end: 0,
      destroy: 0,
      endData: null,
    };
    const writes: Buffer[] = [];
    const stub = {
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
      on(_event: string, _cb: (...args: unknown[]) => void) {
        return stub;
      },
    } as unknown as tls.TLSSocket;
    return { socket: stub, calls, writes };
  }

  it("destroy() is a no-op after end() — preserves graceful TLS close_notify", () => {
    // Engine flow on healthy DONE: enterState(DONE) → transport.end()
    // (FIN), then settle → transport.destroy(). The wrapper must NOT
    // RST the socket on the second call, or TLS close_notify never
    // lands and the printer sees an unclean disconnect.
    const { socket, calls } = makeStubSocket();
    const wrapped = withEsci2UnlockOnDestroy(socket);
    wrapped.end();
    expect(calls.end).toBe(1);
    wrapped.destroy();
    expect(calls.destroy).toBe(0); // <-- the invariant
  });

  it("destroy() force-closes when LOCK was never sent (true error path, pre-LOCK)", () => {
    const { socket, calls } = makeStubSocket();
    const wrapped = withEsci2UnlockOnDestroy(socket);
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
    const { socket, calls } = makeStubSocket();
    const wrapped = withEsci2UnlockOnDestroy(socket);
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
    const { socket, calls } = makeStubSocket();
    const wrapped = withEsci2UnlockOnDestroy(socket);
    wrapped.write(lockPacket());
    wrapped.destroy();
    expect(calls.destroy).toBe(0);
    expect(calls.end).toBe(1);
    expect(calls.endData).not.toBeNull();
    expect(calls.endData?.[2]).toBe(0x21);
    expect(calls.endData?.[3]).toBe(0x01);
  });
});
