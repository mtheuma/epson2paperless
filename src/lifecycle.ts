import { createLogger } from "./logger.js";

const log = createLogger("lifecycle");

export interface InflightTracker {
  /**
   * Register an in-flight promise. The returned promise resolves when the
   * input settles, with rejections swallowed — tracking is about presence,
   * not success. Errors should already be logged at the source.
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
      .catch(() => {
        /* swallow — see JSDoc */
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
