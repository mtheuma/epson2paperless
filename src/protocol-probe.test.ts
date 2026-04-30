import { describe, it, expect, beforeEach, vi } from "vitest";
import tls from "node:tls";
import { detectVariant, resetCache } from "./protocol-probe.js";

describe("protocol-probe", () => {
  beforeEach(() => {
    resetCache();
    vi.restoreAllMocks();
  });

  it("returns the explicit override without probing", async () => {
    const spy = vi.spyOn(tls, "connect");
    const variant = await detectVariant({
      printerIp: "10.0.0.1",
      port: 1865,
      override: "legacy",
      timeoutMs: 100,
    });
    expect(variant).toBe("legacy");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns esci2 when the TLS handshake succeeds", async () => {
    const fakeSocket = {
      destroy: vi.fn(),
      once: (ev: string, cb: () => void) => {
        if (ev === "secureConnect") setImmediate(cb);
        return fakeSocket;
      },
      on: () => fakeSocket,
      setTimeout: () => fakeSocket,
    };
    vi.spyOn(tls, "connect").mockReturnValue(fakeSocket as unknown as tls.TLSSocket);

    const variant = await detectVariant({
      printerIp: "10.0.0.2",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(variant).toBe("esci2");
  });

  it("returns legacy on TLS wrong-version", async () => {
    const fakeSocket = {
      destroy: vi.fn(),
      once: (ev: string, cb: (e: Error) => void) => {
        if (ev === "error") {
          setImmediate(() => {
            const err = new Error("wrong version") as Error & { code?: string };
            err.code = "ERR_SSL_WRONG_VERSION_NUMBER";
            cb(err);
          });
        }
        return fakeSocket;
      },
      on: () => fakeSocket,
      setTimeout: () => fakeSocket,
    };
    vi.spyOn(tls, "connect").mockReturnValue(fakeSocket as unknown as tls.TLSSocket);

    const variant = await detectVariant({
      printerIp: "10.0.0.3",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(variant).toBe("legacy");
  });

  it("caches per-IP across multiple calls", async () => {
    const spy = vi.spyOn(tls, "connect").mockReturnValue({
      destroy: vi.fn(),
      once: (ev: string, cb: () => void) => {
        if (ev === "secureConnect") setImmediate(cb);
        return {} as tls.TLSSocket;
      },
      on: () => ({}) as tls.TLSSocket,
      setTimeout: () => ({}) as tls.TLSSocket,
    } as unknown as tls.TLSSocket);

    await detectVariant({ printerIp: "10.0.0.4", port: 1865, override: "auto", timeoutMs: 100 });
    await detectVariant({ printerIp: "10.0.0.4", port: 1865, override: "auto", timeoutMs: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache legacy results (avoids pinning a misclassified ECONNRESET)", async () => {
    const fakeSocket = {
      destroy: vi.fn(),
      once: (ev: string, cb: (e: Error) => void) => {
        if (ev === "error") {
          setImmediate(() => {
            const err = new Error("conn reset") as Error & { code?: string };
            err.code = "ECONNRESET";
            cb(err);
          });
        }
        return fakeSocket;
      },
      on: () => fakeSocket,
      setTimeout: () => fakeSocket,
    };
    const spy = vi.spyOn(tls, "connect").mockReturnValue(fakeSocket as unknown as tls.TLSSocket);

    const a = await detectVariant({
      printerIp: "10.0.0.6",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    const b = await detectVariant({
      printerIp: "10.0.0.6",
      port: 1865,
      override: "auto",
      timeoutMs: 100,
    });
    expect(a).toBe("legacy");
    expect(b).toBe("legacy");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rejects on timeout", async () => {
    vi.spyOn(tls, "connect").mockReturnValue({
      destroy: vi.fn(),
      once: () => ({}) as tls.TLSSocket,
      on: () => ({}) as tls.TLSSocket,
      setTimeout: () => ({}) as tls.TLSSocket,
    } as unknown as tls.TLSSocket);

    await expect(
      detectVariant({ printerIp: "10.0.0.5", port: 1865, override: "auto", timeoutMs: 50 }),
    ).rejects.toThrow(/timeout/i);
  });
});
