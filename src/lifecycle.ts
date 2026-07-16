import { createLogger } from "./logger.js";

const log = createLogger("lifecycle");

export interface InflightTracker {
  /**
   * Register an in-flight promise. The returned promise resolves when the
   * input settles — tracking is about presence, not success. Rejections
   * are logged at WARN at the catch boundary so the outermost scan-promise
   * failure is never silent (issue #66 — Docker EACCES at temp-dir setup
   * fired before any per-state log and went unobserved). The log may
   * duplicate an inner error already logged at the source; that's
   * acceptable noise to ensure the un-logged path is visible.
   */
  track(p: Promise<void>): Promise<void>;
  /**
   * Wait for every tracked promise to settle, up to `timeoutMs`. Returns
   * the number completed vs. still outstanding when the timeout fired.
   * `timedOut` is 0 on a clean drain. Outstanding promises are left in
   * the set — they'll GC on process exit.
   */
  waitAll(timeoutMs: number): Promise<{ completed: number; timedOut: number }>;
  /** Count of tracked, not-yet-settled promises. */
  readonly count: number;
}

export function createInflightTracker(): InflightTracker {
  const set = new Set<Promise<void>>();

  const track = (p: Promise<void>): Promise<void> => {
    const wrapper = p
      .catch((err: unknown) => {
        log.warn("Tracked scan promise rejected", err);
      })
      .finally(() => {
        set.delete(wrapper);
      });
    set.add(wrapper);
    return wrapper;
  };

  const waitAll = async (timeoutMs: number): Promise<{ completed: number; timedOut: number }> => {
    const snapshot = Array.from(set);
    if (snapshot.length === 0) {
      return { completed: 0, timedOut: 0 };
    }
    const TIMEOUT = Symbol("timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<typeof TIMEOUT>((r) => {
      timeoutHandle = setTimeout(() => r(TIMEOUT), timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.allSettled(snapshot).then(() => "drained" as const),
        timeoutPromise,
      ]);
      if (result === TIMEOUT) {
        return { completed: 0, timedOut: set.size };
      }
      return { completed: snapshot.length, timedOut: 0 };
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  };

  return {
    track,
    waitAll,
    get count() {
      return set.size;
    },
  };
}

export interface ScanNowDeps {
  /** The scan session promise. */
  scan: Promise<void>;
  /** Resolves with the first SIGINT/SIGTERM seen. Never rejects. */
  signalled: Promise<NodeJS.Signals>;
  shutdownTimeoutMs: number;
}

/**
 * Drives a host-triggered single scan to an exit code.
 *
 * A signal drains rather than aborts: killing a scan mid-flight discards
 * pages the printer has already fed. Once a signal is seen its exit code is
 * authoritative — a scan that fails during the drain must not rewrite 130/143
 * to 1. That's guaranteed by mapping `scan` to a value up front, so the
 * settled promise never rejects and a late failure has nothing to escape
 * through.
 *
 * The bounded wait is delegated to inflight.waitAll, which clears its timer in
 * a finally. Don't hand-roll it with an unref'd timer: node could then exit
 * naturally with 0 while a signal's exit code was still pending.
 *
 * The tracker is created here rather than injected. Requiring the caller to
 * register `scan` would put the drain invariant in untested wiring: omit the
 * registration and every test here still passes while signals stop draining.
 */
export async function runScanNowLifecycle(deps: ScanNowDeps): Promise<number> {
  const inflight = createInflightTracker();
  void inflight.track(deps.scan);

  const scanSettled: Promise<{ kind: "complete" } | { kind: "fail"; err: unknown }> =
    deps.scan.then(
      () => ({ kind: "complete" }) as const,
      (err: unknown) => ({ kind: "fail", err }) as const,
    );

  const first = await Promise.race([
    scanSettled,
    deps.signalled.then((signal) => ({ kind: "signal", signal }) as const),
  ]);

  if (first.kind === "signal") {
    log.info(`Received ${first.signal} — waiting up to ${deps.shutdownTimeoutMs}ms for the scan`);
    const drain = await inflight.waitAll(deps.shutdownTimeoutMs);
    if (drain.timedOut > 0) {
      log.warn(`Scan still in flight after ${deps.shutdownTimeoutMs}ms — exiting anyway`);
    } else {
      log.info("Scan drained before exit");
    }
    return first.signal === "SIGTERM" ? 143 : 130;
  }

  if (first.kind === "complete") {
    log.info("Scan complete — shutting down");
    return 0;
  }

  log.error("Scan failed — shutting down", first.err);
  return 1;
}

export interface ShutdownDeps {
  pushscanServer: { close: () => void };
  healthServer: { close: () => void };
  responder: { stop: () => void };
  inflight: InflightTracker;
  shutdownTimeoutMs: number;
  signal: string;
  exit: (code: number) => void;
}

let isShuttingDown = false;

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`Shutting down (signal=${deps.signal}) — inflight=${deps.inflight.count}`);

  const safeCall = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.error(`${label} close failed`, err);
    }
  };

  safeCall("pushscan", () => deps.pushscanServer.close());

  const drainResult = await deps.inflight.waitAll(deps.shutdownTimeoutMs);
  if (drainResult.timedOut > 0) {
    log.warn(
      `${drainResult.timedOut} scan(s) still in flight after ${deps.shutdownTimeoutMs}ms — exiting anyway`,
    );
  } else if (drainResult.completed > 0) {
    log.info(`Drained ${drainResult.completed} in-flight scan(s)`);
  }

  safeCall("health", () => deps.healthServer.close());
  safeCall("responder", () => deps.responder.stop());

  deps.exit(0);
}

/**
 * Test-only: reset the module-scoped shutdown flag. Production code
 * should never call this — once we start shutting down, we don't stop.
 */
export function __resetShutdownStateForTesting(): void {
  isShuttingDown = false;
}
