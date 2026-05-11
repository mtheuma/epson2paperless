import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionTransport } from "../scan-session.js";
import { withRawSocketCleanClose } from "./transport.js";

/** Stub inner transport with end/destroy counters and a `close` trigger. */
function makeStubTransport() {
  const calls = { end: 0, destroy: 0, endData: null as Buffer | null };
  let closeListener: ((hadError?: boolean) => void) | null = null;
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
      if (event === "close") closeListener = cb;
      return stub;
    },
  };
  return {
    transport: stub,
    calls,
    fireClose(hadError?: boolean) {
      closeListener?.(hadError);
    },
  };
}

describe("withRawSocketCleanClose wrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroy() is a no-op after end() — prevents post-FIN RST (issue #72)", () => {
    // Engine's healthy DONE flow: transport.end() sends FIN, then
    // settle() calls transport.destroy(). The wrapper must NOT pass
    // that destroy through, or the FIN-RST race surfaces.
    const { transport, calls } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.end();
    expect(calls.end).toBe(1);
    wrapped.destroy();
    expect(calls.destroy).toBe(0);
  });

  it("destroy() forwards when end() was never called (true error path)", () => {
    const { transport, calls } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.destroy();
    expect(calls.destroy).toBe(1);
    expect(calls.end).toBe(0);
  });

  it("destroy() forwards once close has fired (cleanup is safe post-close)", () => {
    const { transport, calls, fireClose } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.on("close", () => {});
    wrapped.end();
    fireClose(false);
    wrapped.destroy();
    expect(calls.destroy).toBe(1);
  });

  it("forwards end(data?) buffer to inner", () => {
    const { transport, calls } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    const payload = Buffer.from([0x1b, 0x40]);
    wrapped.end(payload);
    expect(calls.end).toBe(1);
    expect(calls.endData?.equals(payload)).toBe(true);
  });

  it("end() is idempotent — second call does not restart the fallback timer", () => {
    const { transport, calls, fireClose } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.on("close", () => {});
    wrapped.end();
    // Advance past half the fallback window, then call end() again.
    // If the second end() restarted the timer, close would have to wait
    // another full window before destroy fires.
    vi.advanceTimersByTime(3000);
    wrapped.end();
    expect(calls.end).toBe(1);
    // Close naturally — clears the (original) timer.
    fireClose(false);
    vi.advanceTimersByTime(10_000);
    expect(calls.destroy).toBe(0);
  });

  it("fallback timer fires inner.destroy() after the window when close never lands", () => {
    // Engine's promise has already settled by this point — the fallback
    // is purely socket-hygiene cleanup so a misbehaving peer can't leak
    // a socket per scan.
    const { transport, calls } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.end();
    expect(calls.destroy).toBe(0);
    vi.advanceTimersByTime(4999);
    expect(calls.destroy).toBe(0); // not before the window
    vi.advanceTimersByTime(1);
    expect(calls.destroy).toBe(1); // fires exactly at the window
  });

  it("fallback timer is cleared when close fires naturally", () => {
    const { transport, calls, fireClose } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    wrapped.on("close", () => {});
    wrapped.end();
    fireClose(false);
    vi.advanceTimersByTime(10_000);
    expect(calls.destroy).toBe(0);
  });

  it("forwards the close event to the engine listener", () => {
    const { transport, fireClose } = makeStubTransport();
    const wrapped = withRawSocketCleanClose(transport);
    const seen: Array<boolean | undefined> = [];
    wrapped.on("close", (hadError?: boolean) => seen.push(hadError));
    fireClose(false);
    fireClose(true);
    expect(seen).toEqual([false, true]);
  });

  it("destroy() forwards an error arg in the true-error path", () => {
    const calls: Array<Error | undefined> = [];
    const stub: SessionTransport = {
      write() {
        return true;
      },
      end() {},
      destroy(err?: Error) {
        calls.push(err);
      },
      on() {
        return stub;
      },
    };
    const wrapped = withRawSocketCleanClose(stub);
    const err = new Error("ECONNREFUSED");
    wrapped.destroy(err);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(err);
  });
});
