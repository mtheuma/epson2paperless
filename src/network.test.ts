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

  it("uses changed DNS results once the staleness window has elapsed", async () => {
    let address = "192.0.2.10";
    let clock = 1_000_000;
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      { lookup: () => Promise.resolve([address]), now: () => clock, refreshIntervalMs: 30_000 },
    );
    expect(await target.target()).toBe("192.0.2.10");

    address = "192.0.2.11";
    clock += 30_000;

    expect(await target.target()).toBe("192.0.2.11");
    expect(await target.accepts("192.0.2.11")).toBe(true);
    target.stop();
  });

  /**
   * The feature's headline claim: a printer that moves address is followed
   * without a restart. Two successive scans, the hostname resolving to a
   * different literal each time — the second scan must use the new one.
   */
  it("routes a second scan to the printer's new address after it moves", async () => {
    let address = "192.0.2.10";
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      { lookup: () => Promise.resolve([address]) },
    );

    // Scan 1: the printer is where DNS said it was.
    expect(await target.accepts("192.0.2.10")).toBe(true);

    // It renumbers, and DNS follows.
    address = "192.0.2.11";

    // Scan 2 arrives from an address not in the known set, which forces the
    // on-demand refresh: the new peer validates, the old one no longer does,
    // and the connect target follows without a restart.
    expect(await target.accepts("192.0.2.11")).toBe(true);
    expect(await target.accepts("192.0.2.10")).toBe(false);
    expect(await target.target()).toBe("192.0.2.11");
    target.stop();
  });

  it("resolves exactly once across construction and a first target()", async () => {
    let calls = 0;
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      {
        lookup: () => {
          calls++;
          return Promise.resolve(["192.0.2.10"]);
        },
      },
    );

    expect(await target.target()).toBe("192.0.2.10");
    // target() honours the staleness guard, so it reuses the address the
    // constructor already resolved instead of paying a second lookup on
    // every daemon start and every scan:now.
    expect(calls).toBe(1);
    target.stop();
  });

  it("gives up on a lookup that never settles, naming the hostname", async () => {
    const started = Date.now();
    await expect(
      createPrinterTarget(
        { printerHostname: "printer.lan" },
        { lookup: () => new Promise<string[]>(() => {}), lookupTimeoutMs: 50 },
      ),
    ).rejects.toThrow(/printer\.lan.*timed out after 50ms/);
    // dns.lookup has no timeout of its own; without the bound this would hang
    // for as long as the OS resolver takes, holding a libuv threadpool slot.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("caps how many wedged lookups can be parked at once", async () => {
    // Timing the caller out does not cancel the getaddrinfo behind it, so
    // starting a fresh lookup on every refresh would park a new thread each
    // time -- once per interval, or ~1 Hz through accepts() -- until the
    // four-thread pool sharp encodes on is full.
    let calls = 0;
    const lookup = (): Promise<string[]> => {
      calls++;
      // First call succeeds so construction has a last-known-good set to
      // retain; everything after it hangs forever.
      return calls === 1 ? Promise.resolve(["192.0.2.58"]) : new Promise<string[]>(() => {});
    };

    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      { lookup, lookupTimeoutMs: 20, refreshIntervalMs: 0 },
    );
    expect(calls).toBe(1);

    // Far more refreshes than the cap. Each times out; once two lookups are
    // parked the rest are refused outright rather than parking more.
    for (let i = 0; i < 6; i++) await target.refresh(true);

    expect(calls).toBe(3); // the initial success, plus MAX_OUTSTANDING_LOOKUPS
    expect([...target.addresses]).toEqual(["192.0.2.58"]);
    target.stop();
  });

  it("still resolves once a wedged lookup's successor succeeds", async () => {
    // The other half of the tradeoff: bounding parked lookups must not pin
    // resolution forever. A lookup that never settles has to release the join
    // slot when its caller-facing budget expires, so the next refresh issues a
    // genuinely new query — otherwise every later refresh joins a dead promise,
    // the address set can never change, and only a restart recovers.
    let calls = 0;
    const lookup = (): Promise<string[]> => {
      calls++;
      if (calls === 1) return Promise.resolve(["192.0.2.10"]);
      if (calls === 2) return new Promise<string[]>(() => {}); // wedges forever
      return Promise.resolve(["192.0.2.99"]); // resolver has recovered
    };

    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      { lookup, lookupTimeoutMs: 20, refreshIntervalMs: 0 },
    );

    await target.refresh(true); // call 2 — wedges, times out, releases the slot
    await target.refresh(true); // call 3 — succeeds against the healthy resolver

    expect([...target.addresses]).toEqual(["192.0.2.99"]);
    expect(await target.accepts("192.0.2.99")).toBe(true);
    target.stop();
  });

  it("lets a second unknown peer join an in-flight lookup instead of being throttled", async () => {
    let calls = 0;
    let resolveRefresh!: (addresses: string[]) => void;
    const target = await createPrinterTarget(
      { printerHostname: "printer.lan" },
      {
        lookup: () => {
          calls++;
          if (calls === 1) return Promise.resolve(["192.0.2.10"]);
          return new Promise<string[]>((resolve) => {
            resolveRefresh = resolve;
          });
        },
      },
    );

    // Both peers arrive inside the resolver window. The first starts the
    // refresh; the second used to be turned away by the 1 s throttle — whose
    // timestamp is stamped before the lookup resolves — and tested against the
    // stale set. It must join the in-flight lookup instead.
    const first = target.accepts("192.0.2.11");
    const second = target.accepts("192.0.2.11");
    await Promise.resolve();
    resolveRefresh(["192.0.2.11"]);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toBe(2);
    target.stop();
  });
});
