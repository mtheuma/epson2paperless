import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createInflightTracker,
  runScanNowLifecycle,
  runOneShotLifecycle,
  shutdown,
  type OneShotDeps,
  type ShutdownDeps,
  __resetShutdownStateForTesting,
} from "./lifecycle.js";
import { createSingleScanAdmission } from "./scan-admission.js";

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

describe("runOneShotLifecycle", () => {
  const never = new Promise<NodeJS.Signals>(() => {});
  const neverStarted = new Promise<{ scan: Promise<void> }>(() => {});
  const sigterm = (): Promise<NodeJS.Signals> => Promise.resolve("SIGTERM" as NodeJS.Signals);
  const sigint = (): Promise<NodeJS.Signals> => Promise.resolve("SIGINT" as NodeJS.Signals);

  function defer<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** Advance no fake time, but let every pending microtask chain run. */
  const flush = () => vi.advanceTimersByTimeAsync(0);

  function makeOneShotDeps(overrides: Partial<OneShotDeps> = {}) {
    const admission = createSingleScanAdmission();
    const stopAcceptingTriggers = vi.fn();
    const deps: OneShotDeps = {
      scanStarted: neverStarted,
      signalled: never,
      admission,
      stopAcceptingTriggers,
      shutdownTimeoutMs: 30_000,
      ...overrides,
    };
    return { deps, admission: deps.admission, stopAcceptingTriggers };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The whole budget calculation depends on Date.now() moving with the fake
  // clock. Pin that assumption rather than trusting the default `toFake` list.
  it("runs on a faked Date.now, so deadline maths is deterministic", () => {
    const before = Date.now();
    vi.advanceTimersByTime(5_000);
    expect(Date.now() - before).toBe(5_000);
  });

  it("exits 143 at once on SIGTERM with nothing admitted", async () => {
    const { deps, stopAcceptingTriggers } = makeOneShotDeps({ signalled: sigterm() });
    await expect(runOneShotLifecycle(deps)).resolves.toBe(143);
    expect(stopAcceptingTriggers).toHaveBeenCalledTimes(1);
  });

  it("exits 130 at once on SIGINT with nothing admitted", async () => {
    const { deps, stopAcceptingTriggers } = makeOneShotDeps({ signalled: sigint() });
    await expect(runOneShotLifecycle(deps)).resolves.toBe(130);
    expect(stopAcceptingTriggers).toHaveBeenCalledTimes(1);
  });

  it("delegates to runScanNowLifecycle when a scan started first (0 on success)", async () => {
    const { deps, stopAcceptingTriggers } = makeOneShotDeps({
      scanStarted: Promise.resolve({ scan: Promise.resolve() }),
    });
    await expect(runOneShotLifecycle(deps)).resolves.toBe(0);
    expect(stopAcceptingTriggers).not.toHaveBeenCalled();
  });

  it("delegates to runScanNowLifecycle when a scan started first (1 on failure)", async () => {
    const { deps } = makeOneShotDeps({
      scanStarted: Promise.resolve({ scan: Promise.reject(new Error("boom")) }),
    });
    await expect(runOneShotLifecycle(deps)).resolves.toBe(1);
  });

  // The #202 case: SIGTERM lands after beforeResponse reserved the slot but
  // before the callback ran. The scan does start, and its real result wins.
  it("waits for an admitted trigger to start, then reports the scan's own result", async () => {
    const started = defer<{ scan: Promise<void> }>();
    const scan = defer<void>();
    const { deps, admission, stopAcceptingTriggers } = makeOneShotDeps({
      scanStarted: started.promise,
      signalled: sigterm(),
    });
    admission.reserve();

    let settled: number | undefined;
    const result = runOneShotLifecycle(deps);
    void result.then((code) => (settled = code));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeUndefined();

    admission.commit();
    started.resolve({ scan: scan.promise });
    await flush();
    scan.resolve();

    await expect(result).resolves.toBe(0);
    expect(stopAcceptingTriggers).toHaveBeenCalledTimes(1);
  });

  // One budget, measured from signal receipt — not one for the wait plus a
  // fresh one for the drain. Start at +2000 must still end at +30000.
  it("shares one SHUTDOWN_TIMEOUT_MS budget across the wait and the drain", async () => {
    const started = defer<{ scan: Promise<void> }>();
    const { deps, admission } = makeOneShotDeps({
      scanStarted: started.promise,
      signalled: sigterm(),
      shutdownTimeoutMs: 30_000,
    });
    admission.reserve();

    let settled: number | undefined;
    void runOneShotLifecycle(deps).then((code) => (settled = code));

    await vi.advanceTimersByTimeAsync(2_000);
    admission.commit();
    started.resolve({ scan: new Promise<void>(() => {}) }); // never settles
    await flush();

    await vi.advanceTimersByTimeAsync(27_000); // t = 29_000
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000); // t = 30_000
    expect(settled).toBe(143);
  });

  it("exits promptly when the admitted trigger is abandoned via its release hook", async () => {
    const { deps, admission } = makeOneShotDeps({ signalled: sigint() });
    const release = admission.reserve();

    let settled: number | undefined;
    void runOneShotLifecycle(deps).then((code) => (settled = code));
    await flush();
    expect(settled).toBeUndefined();

    release();
    await flush();
    expect(settled).toBe(130);
  });

  it("exits promptly when the callback's reject arm releases the admission", async () => {
    const { deps, admission } = makeOneShotDeps({ signalled: sigterm() });
    admission.reserve();

    let settled: number | undefined;
    void runOneShotLifecycle(deps).then((code) => (settled = code));
    await flush();
    expect(settled).toBeUndefined();

    admission.release(); // e.g. PREVIEW_ACTION=reject
    await flush();
    expect(settled).toBe(143);
  });

  it("warns and exits with the signal code when the trigger never starts a scan", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps, admission } = makeOneShotDeps({ signalled: sigterm() });
      admission.reserve();

      let settled: number | undefined;
      void runOneShotLifecycle(deps).then((code) => (settled = code));

      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(143);

      const warned = warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(warned).toContain("[WARN]");
      expect(warned).toContain("30000ms");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
