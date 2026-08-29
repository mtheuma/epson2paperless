import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { createPrinterTarget, getLocalIpForTarget, normalizeIPv4 } from "./network.js";

/**
 * Behaviorally-rich fake `dgram.Socket` for the UDP `connect()` path that
 * `getLocalIpForTarget` uses to discover which local interface can reach
 * a given target. Only the surface `getLocalIpForTarget` actually touches
 * is modeled — `connect`, `address`, `close`, plus `'error'` events from
 * the EventEmitter base.
 */
class FakeUdpSocket extends EventEmitter {
  private behavior:
    | { kind: "success"; localAddress: string }
    | { kind: "error"; code: string; message: string };
  closed = false;
  connectCalls: { port: number; host: string }[] = [];

  constructor(behavior: FakeUdpSocket["behavior"]) {
    super();
    this.behavior = behavior;
  }

  connect(port: number, host: string, cb: () => void): void {
    this.connectCalls.push({ port, host });
    if (this.behavior.kind === "success") {
      // Real dgram.connect fires the callback async; mimic with setImmediate
      // so getLocalIpForTarget's resolve + close ordering is realistic.
      setImmediate(cb);
    } else {
      const err = new Error(this.behavior.message) as Error & { code?: string };
      err.code = this.behavior.code;
      setImmediate(() => this.emit("error", err));
    }
  }

  address(): dgram.AddressInfo {
    if (this.behavior.kind !== "success") {
      throw new Error("FakeUdpSocket.address() called on error-path fake");
    }
    return { address: this.behavior.localAddress, family: "IPv4", port: 12345 };
  }

  close(): void {
    this.closed = true;
  }
}

function mockCreateSocket(fake: FakeUdpSocket): void {
  vi.spyOn(dgram, "createSocket").mockImplementation(
    (..._args: unknown[]) => fake as unknown as dgram.Socket,
  );
}

describe("getLocalIpForTarget", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with the local interface address chosen by the OS", async () => {
    const fake = new FakeUdpSocket({ kind: "success", localAddress: "10.0.0.42" });
    mockCreateSocket(fake);

    await expect(getLocalIpForTarget("192.0.2.58")).resolves.toBe("10.0.0.42");
    expect(fake.closed).toBe(true);
    expect(fake.connectCalls).toEqual([{ port: 1, host: "192.0.2.58" }]);
  });

  it("rejects with target-IP context when the underlying socket errors", async () => {
    const fake = new FakeUdpSocket({
      kind: "error",
      code: "EHOSTUNREACH",
      message: "host is unreachable",
    });
    mockCreateSocket(fake);

    await expect(getLocalIpForTarget("203.0.113.99")).rejects.toThrow(
      /Cannot determine local IP for target 203\.0\.113\.99/,
    );
  });

  it("includes the underlying error message in the rejection", async () => {
    const fake = new FakeUdpSocket({
      kind: "error",
      code: "ENETUNREACH",
      message: "network is unreachable",
    });
    mockCreateSocket(fake);

    await expect(getLocalIpForTarget("198.51.100.1")).rejects.toThrow(/network is unreachable/);
  });

  it("closes the socket on the error path (no leak)", async () => {
    const fake = new FakeUdpSocket({
      kind: "error",
      code: "EHOSTUNREACH",
      message: "boom",
    });
    mockCreateSocket(fake);

    await expect(getLocalIpForTarget("192.0.2.99")).rejects.toThrow();
    expect(fake.closed).toBe(true);
  });

  it("requests an IPv4 socket from dgram.createSocket", async () => {
    const fake = new FakeUdpSocket({ kind: "success", localAddress: "10.0.0.1" });
    const spy = vi
      .spyOn(dgram, "createSocket")
      .mockImplementation((..._args: unknown[]) => fake as unknown as dgram.Socket);

    await getLocalIpForTarget("192.0.2.5");
    expect(spy).toHaveBeenCalledWith("udp4");
  });
});

describe("printer target", () => {
  it("normalizes IPv4-mapped IPv6", () => {
    expect(normalizeIPv4("::ffff:192.168.1.174")).toBe("192.168.1.174");
    expect(normalizeIPv4("2001:db8::1")).toBeNull();
  });

  it("retains the last-known-good set after a refresh failure", async () => {
    let calls = 0;
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      {
        lookup: () =>
          calls++ === 0 ? Promise.resolve(["192.0.2.10"]) : Promise.reject(new Error("timeout")),
      },
    );
    await target.refresh(true);
    expect(target.addresses).toEqual(new Set(["192.0.2.10"]));
    target.stop();
  });

  it("uses changed DNS results for the next target operation", async () => {
    let address = "192.0.2.10";
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      { lookup: () => Promise.resolve([address]) },
    );
    address = "192.0.2.11";
    expect(await target.target()).toBe("192.0.2.11");
    expect(await target.accepts("192.0.2.11")).toBe(true);
    target.stop();
  });
});
