import { createLogger } from "./logger.js";
import type { SingleScanAdmission } from "./scan-admission.js";

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
 * A signal drains rather than aborts: killing a scan mid-flight discards pages
 * the printer has already fed. The exit code then reflects what the drain
 * found, not merely that a signal arrived:
 *   - scan still in flight when the drain times out → the signal code
 *     (130 SIGINT / 143 SIGTERM). The signal is what actually ends the run.
 *   - scan settled during the drain → its real result (0 complete, 1 failed).
 *
 * Returning the signal code for a scan that finished cleanly would misreport a
 * success — and, worse, push an automation runner that retries on non-zero to
 * fire a second physical scan (and a duplicate Paperless upload, since the
 * first run may already have committed and deleted the local file). So a clean
 * drain returns the scan's own outcome; a failed scan during the drain returns
 * 1 rather than hiding the failure behind the signal.
 *
 * `scan` is mapped to a value up front, so `scanSettled` never rejects and a
 * late failure has nothing to escape through as an unhandled rejection — which
 * is also why awaiting it after the drain is safe.
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
      // Scan genuinely still running — the signal is what ends the process.
      log.warn(`Scan still in flight after ${deps.shutdownTimeoutMs}ms — exiting anyway`);
      return first.signal === "SIGTERM" ? 143 : 130;
    }
    // Scan settled during the drain: report what actually happened, not the
    // signal. scanSettled is already resolved and never rejects.
    const settled = await scanSettled;
    if (settled.kind === "complete") {
      log.info(`Scan completed during ${first.signal} drain — shutting down`);
      return 0;
    }
    log.error(`Scan failed during ${first.signal} drain — shutting down`, settled.err);
    return 1;
  }

  if (first.kind === "complete") {
    log.info("Scan complete — shutting down");
    return 0;
  }

  log.error("Scan failed — shutting down", first.err);
  return 1;
}

export interface OneShotDeps {
  /** Resolves when the first accepted panel trigger has started a session. */
  scanStarted: Promise<{ scan: Promise<void> }>;
  /** Resolves with the first SIGINT/SIGTERM seen. Never rejects. */
  signalled: Promise<NodeJS.Signals>;
  /** One-shot's admission gate — read for the admission gap, not mutated here. */
  admission: Pick<SingleScanAdmission, "isBusy" | "onReleased">;
  /**
   * Stop admitting new panel triggers. `net.Server.close()` stops accepting
   * new connections and leaves established ones alone, so the trigger already
   * being admitted is unaffected.
   */
  stopAcceptingTriggers: () => void;
  shutdownTimeoutMs: number;
}

/**
 * Drives one-shot (`npm run scan`) to an exit code.
 *
 * A signal that arrives before any scan started used to exit at once on the
 * grounds that there was nothing to drain. But a panel press is admitted — and
 * *reserved* — in `beforeResponse`, well before the `onPushScan` callback that
 * resolves `scanStarted`: on the FF-680W / DS-575W that gap holds a JOBR
 * round-trip, and on every model it holds the OK write. Exiting inside it
 * tears the trigger socket down mid-response (the panel shows an error), or
 * leaves the printer holding an OK for a session that never opens (issue
 * #202). `admission.isBusy()` is what distinguishes the two cases.
 *
 * So when a signal lands inside the gap, new triggers stop being accepted and
 * the admitted one is given the rest of the SHUTDOWN_TIMEOUT_MS budget to
 * start. A fixed "wait a few seconds" delay would not do: job-control applies
 * its 3 s timeout separately to the connect and to each successive read, so a
 * failing JOBR gap can run to roughly 15 s. The budget is a deadline measured
 * from signal receipt, and only what is left of it is passed into the scan
 * drain — the wait and the drain share one SHUTDOWN_TIMEOUT_MS, they don't get
 * one each.
 *
 * The wait ends early if the reservation is dropped without a commit (socket
 * closed, ERROR response, undeliverable response, or the callback's reject
 * arm), which `admission.onReleased` reports without polling.
 */
export async function runOneShotLifecycle(deps: OneShotDeps): Promise<number> {
  const first = await Promise.race([
    deps.scanStarted.then(({ scan }) => ({ kind: "scan", scan }) as const),
    deps.signalled.then((signal) => ({ kind: "signal", signal }) as const),
  ]);

  if (first.kind === "scan") {
    return runScanNowLifecycle({
      scan: first.scan,
      signalled: deps.signalled,
      shutdownTimeoutMs: deps.shutdownTimeoutMs,
    });
  }

  // The single budget for everything that follows, from signal receipt.
  const deadline = Date.now() + deps.shutdownTimeoutMs;
  const signalCode = first.signal === "SIGTERM" ? 143 : 130;
  // Safe in both branches: the process is on its way out either way, and an
  // already-established trigger connection is not affected.
  deps.stopAcceptingTriggers();

  if (!deps.admission.isBusy()) {
    log.info(`Received ${first.signal} before any scan started — shutting down`);
    return signalCode;
  }

  log.info(
    `Received ${first.signal} while a panel trigger is being admitted — ` +
      `waiting up to ${deps.shutdownTimeoutMs}ms for it to start`,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let outcome: { kind: "scan"; scan: Promise<void> } | { kind: "released" } | { kind: "deadline" };
  try {
    outcome = await Promise.race([
      deps.scanStarted.then(({ scan }) => ({ kind: "scan", scan }) as const),
      new Promise<{ kind: "released" }>((resolve) => {
        deps.admission.onReleased(() => resolve({ kind: "released" }));
      }),
      new Promise<{ kind: "deadline" }>((resolve) => {
        // Not unref'd on purpose: node must not exit naturally with 0 while
        // this exit code is still pending (same reasoning as waitAll).
        timer = setTimeout(() => resolve({ kind: "deadline" }), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (outcome.kind === "scan") {
    // `signalled` is already resolved, so this goes straight into its drain —
    // with what is left of the budget, not a fresh one.
    return runScanNowLifecycle({
      scan: outcome.scan,
      signalled: deps.signalled,
      shutdownTimeoutMs: Math.max(0, deadline - Date.now()),
    });
  }

  if (outcome.kind === "released") {
    log.info(`Panel trigger ended without starting a scan — shutting down on ${first.signal}`);
    return signalCode;
  }

  log.warn(
    `Panel trigger did not start a scan within ${deps.shutdownTimeoutMs}ms — exiting anyway`,
  );
  return signalCode;
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
