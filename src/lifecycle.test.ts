import { describe, it, expect, beforeEach } from "vitest";
import {
  createInflightTracker,
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
    const p = tracker.track(Promise.reject(new Error("boom")));
    await expect(p).resolves.toBeUndefined();
    expect(tracker.count).toBe(0);
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
