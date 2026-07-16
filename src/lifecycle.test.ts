import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createInflightTracker,
  runScanNowLifecycle,
  shutdown,
  type ShutdownDeps,
  __resetShutdownStateForTesting,
} from "./lifecycle.js";

describe("InflightTracker", () => {
  it("starts with count 0", () => {
    const tracker = createInflightTracker();
    expect(tracker.count).toBe(0);
  });

  it("tracks a resolved promise; count returns to 0 after settle", async () => {
    const tracker = createInflightTracker();
    const p = tracker.track(Promise.resolve());
    expect(tracker.count).toBe(1);
    await p;
    expect(tracker.count).toBe(0);
  });

  it("settles the tracker slot even when the tracked promise rejects", async () => {
    const tracker = createInflightTracker();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p = tracker.track(Promise.reject(new Error("boom")));
      await expect(p).resolves.toBeUndefined();
      expect(tracker.count).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs at WARN when the tracked promise rejects (issue #66)", async () => {
    const tracker = createInflightTracker();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = new Error("EACCES: permission denied");
      await tracker.track(Promise.reject(err));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const callArgs = warnSpy.mock.calls[0];
      const joined = callArgs.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      expect(joined).toContain("[WARN]");
      expect(joined).toContain("[lifecycle]");
      expect(joined).toContain("Tracked scan promise rejected");
      expect(joined).toContain("EACCES: permission denied");
      expect(callArgs).toContain(err);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("count reflects concurrent in-flight work", async () => {
    const tracker = createInflightTracker();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const second = new Promise<void>((r) => {
      resolveSecond = r;
    });
    tracker.track(first);
    tracker.track(second);
    expect(tracker.count).toBe(2);
    resolveFirst();
    await new Promise((r) => setImmediate(r));
    expect(tracker.count).toBe(1);
    resolveSecond();
    await new Promise((r) => setImmediate(r));
    expect(tracker.count).toBe(0);
  });

  it("waitAll resolves immediately when tracker is empty", async () => {
    const tracker = createInflightTracker();
    const result = await tracker.waitAll(1000);
    expect(result).toEqual({ completed: 0, timedOut: 0 });
  });

  it("waitAll drains all in-flight promises within timeout", async () => {
    const tracker = createInflightTracker();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    tracker.track(
      new Promise<void>((r) => {
        resolveFirst = r;
      }),
    );
    tracker.track(
      new Promise<void>((r) => {
        resolveSecond = r;
      }),
    );
    const waitPromise = tracker.waitAll(1000);
    setImmediate(() => {
      resolveFirst();
      resolveSecond();
    });
    const result = await waitPromise;
    expect(result).toEqual({ completed: 2, timedOut: 0 });
  });

  it("waitAll reports timedOut count when promises exceed timeoutMs", async () => {
    const tracker = createInflightTracker();
    tracker.track(new Promise<void>(() => {}));
    tracker.track(new Promise<void>(() => {}));
    const result = await tracker.waitAll(20);
    expect(result).toEqual({ completed: 0, timedOut: 2 });
    expect(tracker.count).toBe(2);
  });
});

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & {
  callOrder: string[];
  exitCalls: number[];
} {
  const callOrder: string[] = [];
  const exitCalls: number[] = [];
  const tracker = createInflightTracker();
  const deps: ShutdownDeps = {
    pushscanServer: {
      close: () => {
        callOrder.push("pushscan");
      },
    },
    healthServer: {
      close: () => {
        callOrder.push("health");
      },
    },
    responder: {
      stop: () => {
        callOrder.push("responder");
      },
    },
    inflight: tracker,
    shutdownTimeoutMs: 1000,
    signal: "TEST",
    exit: (code: number) => {
      exitCalls.push(code);
    },
    ...overrides,
  };
  return Object.assign(deps, { callOrder, exitCalls });
}

describe("shutdown", () => {
  beforeEach(() => {
    __resetShutdownStateForTesting();
  });

  it("closes servers in order (pushscan, health, responder) and exits 0", async () => {
    const deps = makeDeps();
    await shutdown(deps);
    expect(deps.callOrder).toEqual(["pushscan", "health", "responder"]);
    expect(deps.exitCalls).toEqual([0]);
  });

  it("waits for in-flight scans to drain before closing health server", async () => {
    const deps = makeDeps();
    let resolveScan!: () => void;
    deps.inflight.track(
      new Promise<void>((r) => {
        resolveScan = r;
      }),
    );
    const shutdownPromise = shutdown(deps);
    await new Promise((r) => setImmediate(r));
    expect(deps.callOrder).toEqual(["pushscan"]);
    resolveScan();
    await shutdownPromise;
    expect(deps.callOrder).toEqual(["pushscan", "health", "responder"]);
  });

  it("proceeds to close servers after timeout when a scan is hung", async () => {
    const deps = makeDeps({ shutdownTimeoutMs: 20 });
    deps.inflight.track(new Promise<void>(() => {}));
    await shutdown(deps);
    expect(deps.callOrder).toEqual(["pushscan", "health", "responder"]);
    expect(deps.exitCalls).toEqual([0]);
  });

  it("is idempotent — second call is a no-op", async () => {
    const deps = makeDeps();
    await shutdown(deps);
    await shutdown(deps);
    expect(deps.callOrder).toEqual(["pushscan", "health", "responder"]);
    expect(deps.exitCalls).toEqual([0]);
  });

  it("logs and continues when a close throws", async () => {
    const deps = makeDeps({
      healthServer: {
        close: () => {
          throw new Error("health close failed");
        },
      },
    });
    await shutdown(deps);
    expect(deps.callOrder).toEqual(["pushscan", "responder"]);
    expect(deps.exitCalls).toEqual([0]);
  });
});

describe("runScanNowLifecycle", () => {
  const never = new Promise<NodeJS.Signals>(() => {});

  function deps(scan: Promise<void>, signalled: Promise<NodeJS.Signals>, shutdownTimeoutMs = 50) {
    return { scan, signalled, shutdownTimeoutMs };
  }

  it("exits 0 when the scan completes", async () => {
    await expect(runScanNowLifecycle(deps(Promise.resolve(), never))).resolves.toBe(0);
  });

  it("exits 1 when the scan fails", async () => {
    const scan = Promise.reject(new Error("boom"));
    await expect(runScanNowLifecycle(deps(scan, never))).resolves.toBe(1);
  });

  // 130/143 mean "the signal is what ended the run" — i.e. the scan was still
  // in flight when the drain timed out. A never-settling scan forces that path.
  it("returns 130 when SIGINT fires and the scan does not finish before the drain times out", async () => {
    const code = await runScanNowLifecycle(
      deps(new Promise<void>(() => {}), Promise.resolve("SIGINT" as NodeJS.Signals), 20),
    );
    expect(code).toBe(130);
  });

  it("returns 143 when SIGTERM fires and the scan does not finish before the drain times out", async () => {
    const code = await runScanNowLifecycle(
      deps(new Promise<void>(() => {}), Promise.resolve("SIGTERM" as NodeJS.Signals), 20),
    );
    expect(code).toBe(143);
  });

  // A signal that arrives while the scan is nearly done: the drain lets it
  // finish, and because it finished the real outcome (0) is reported, NOT the
  // signal code. Reporting 130 here would push an automation runner to retry a
  // scan that already succeeded (and may already be uploaded) — a duplicate.
  it("returns 0 when a signal arrives but the scan finishes cleanly during the drain", async () => {
    let done = false;
    const scan = new Promise<void>((r) =>
      setTimeout(() => {
        done = true;
        r();
      }, 20),
    );
    const code = await runScanNowLifecycle(
      deps(scan, Promise.resolve("SIGINT" as NodeJS.Signals), 500),
    );
    expect(done).toBe(true); // drained, not aborted
    expect(code).toBe(0); // real outcome, not the signal code
  });

  // The flip side: a scan that FAILS during the drain reports its real failure
  // (1), not the signal code — a failure must not be hidden behind 130/143.
  // It must also not surface as an unhandled rejection (scanSettled is mapped
  // to a value, so awaiting it after the drain cannot throw).
  it("returns 1 when the scan fails during the drain", async () => {
    const scan = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late")), 10));
    await expect(
      runScanNowLifecycle(deps(scan, Promise.resolve("SIGINT" as NodeJS.Signals), 500)),
    ).resolves.toBe(1);
  });
});
