// src/scan-admission.ts
//
// One scan at a time, whichever door it came through (issue #137). The
// printer serves a single session, so the panel trigger (TCP 2968) and the
// POST /scan webhook share this gate.
//
// Why a reservation and not just the inflight count: a panel trigger is not
// a tracked scan until the OK response has been flushed and the onPushScan
// callback runs. For the FF-680W / DS-575W that gap contains a job-control
// round-trip to the printer (JOBR over 1865, up to 3 s), and for every model
// it contains the response write. Reading only the count would admit a
// webhook inside that gap and start two scans. So the panel gate reserves
// the slot at admission, and the reservation is dropped either by commit()
// (the callback tracked the real scan) or by a release hook the push-scan
// server fires when the trigger ends without a callback.
//
// The gate and the daemon's shutdown drain answer different questions. The
// gate (isBusy) reads the hold and the scans. The drain reads the inflight
// tracker, which holds those and more: the reservation itself, so a signal in
// the admission→callback gap waits instead of exiting mid-transaction, and a
// bounded hand-off after a JobList, so the listener stays open for the
// PushScan that follows on a fresh connection — which the gate must not
// refuse (issue #207).
import type { InflightTracker } from "./lifecycle.js";

export interface ScanAdmission {
  /** True while a scan is tracked or a panel trigger holds the slot. */
  isBusy(): boolean;
  /**
   * Hold the slot for a panel trigger that has just been admitted. Returns a
   * release hook that drops this reservation only (a stale hook cannot drop
   * a newer one) and is safe to call more than once.
   */
  reserve(): () => void;
  /** The admitted panel trigger became a scan: track it, then drop the hold. */
  commit(scan: Promise<void>): void;
  /** The admitted panel trigger will not scan (e.g. PREVIEW_ACTION=reject). */
  release(): void;
  /** Track a scan that holds no reservation (the webhook path). */
  track(scan: Promise<void>): void;
  /**
   * A JobList was answered: keep the drain waiting for its follow-up PushScan
   * for at most `timeoutMs`, without gating it. Ended early by the next
   * reserve() — whatever press arrives is the one the process stayed up for.
   * A newer JobList replaces the hand-off.
   */
  expectFollowUp(timeoutMs: number): void;
}

/**
 * The reservation itself, shared by both admissions below. Each reserve()
 * mints a fresh token so a hook from an earlier, abandoned trigger cannot
 * drop a newer trigger's hold.
 *
 * `onDropped` fires only when a hold that was actually current is cleared —
 * never for a stale hook, never for a clear() on an empty slot. One-shot uses
 * it to learn that an admitted trigger ended (issue #202); the daemon uses it
 * to settle the hold's inflight promise (issue #207).
 */
function createReservationSlot(onDropped?: () => void) {
  let current: symbol | null = null;
  const drop = (): void => {
    if (current === null) return;
    current = null;
    onDropped?.();
  };
  return {
    held: (): boolean => current !== null,
    reserve: (): (() => void) => {
      const token = Symbol("scan-reservation");
      current = token;
      return () => {
        if (current === token) drop();
      };
    },
    clear: drop,
  };
}

/** A promise parked in the tracker until `settle` is called. */
function trackDeferred(inflight: Pick<InflightTracker, "track">): () => void {
  let resolve!: () => void;
  void inflight.track(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  return resolve;
}

export function createScanAdmission(inflight: InflightTracker): ScanAdmission {
  // The hold is itself a tracked promise, so the daemon's shutdown drain waits
  // out the admission→callback gap with no coordinator of its own (issue
  // #207): reserve() parks a deferred in the tracker, and whatever drops the
  // hold — release(), the trigger's own release hook, or commit() — settles it
  // through the slot's onDropped. The slot's token check still decides what
  // is current, so a stale hook drops nothing and settles nothing.
  let settleHold: (() => void) | null = null;
  const slot = createReservationSlot(() => {
    settleHold?.();
    settleHold = null;
  });
  // Scans are counted here rather than read off the tracker: the tracker also
  // holds the reservation, a JobList hand-off, and the hooks, none of which
  // may gate the press they exist for.
  let scans = 0;
  const trackScan = (scan: Promise<void>): void => {
    scans++;
    void inflight.track(scan).finally(() => {
      scans--;
    });
  };
  let endHandoff: (() => void) | null = null;

  return {
    isBusy: () => slot.held() || scans > 0,
    reserve() {
      // The follow-up (or any press) has arrived: its hold takes over, tracked
      // before the hand-off settles so the drain never reads empty between.
      // The gate never reserves on top of a live hold, but if it ever did the
      // old deferred must not sit in the tracker for good and wedge shutdown.
      settleHold?.();
      settleHold = trackDeferred(inflight);
      endHandoff?.();
      return slot.reserve();
    },
    commit(scan) {
      // Track before clearing so isBusy() never reads false in between, and
      // so a drain that snapshotted the hold finds the scan on its next pass.
      trackScan(scan);
      slot.clear();
    },
    release: slot.clear,
    track: trackScan,
    expectFollowUp(timeoutMs) {
      endHandoff?.();
      const settle = trackDeferred(inflight);
      const timer = setTimeout(() => endHandoff?.(), timeoutMs);
      endHandoff = () => {
        clearTimeout(timer);
        endHandoff = null;
        settle();
      };
    },
  };
}

/**
 * One-shot's variant (issue #198): the process serves exactly one scan and
 * then exits, so once a trigger is committed the slot stays busy for good.
 * Same reservation for the gap between `beforeResponse` and the callback,
 * but there is no tracker to consult: the scan's own lifetime is owned by
 * `runScanNowLifecycle`, and the JobList hand-off is a flag the shutdown
 * coordinator reads through `followUpPending()` (issue #209).
 */
export interface SingleScanAdmission extends Pick<
  ScanAdmission,
  "isBusy" | "reserve" | "release" | "expectFollowUp"
> {
  /** The admitted trigger became the scan. Nothing reopens the slot after this. */
  commit(): void;
  /**
   * True from expectFollowUp() until the next reserve() or the timeout. Never
   * makes the gate busy: the follow-up PushScan it waits for must be admitted.
   */
  followUpPending(): boolean;
  /**
   * Register a listener for "the admitted trigger ended without becoming a
   * scan" — release(), or the trigger's own release hook dropping a hold that
   * is still current — and for a JobList hand-off lapsing with no follow-up.
   * Never fired by commit(), by a stale hook, by a release once committed, or
   * by a hand-off that a press ended or a newer JobList replaced. One-shot's
   * shutdown coordinator waits on this so a signal that lands in the
   * admission→callback gap can tell an abandoned trigger from one still
   * starting, without polling (issue #202, issue #209).
   */
  onReleased(listener: () => void): void;
}

export function createSingleScanAdmission(): SingleScanAdmission {
  let committed = false;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    // Post-commit the slot no longer speaks for the trigger: the scan owns it.
    if (committed) return;
    for (const listener of listeners) listener();
  };
  const slot = createReservationSlot(notify);
  let handoffTimer: ReturnType<typeof setTimeout> | null = null;
  const endHandoff = (): void => {
    if (handoffTimer === null) return;
    clearTimeout(handoffTimer);
    handoffTimer = null;
  };

  return {
    isBusy: () => committed || slot.held(),
    reserve() {
      // The follow-up (or any press) has arrived: it is the trigger the
      // coordinator stayed up for, and the hold takes over from here.
      endHandoff();
      return slot.reserve();
    },
    commit() {
      committed = true;
    },
    release: slot.clear,
    expectFollowUp(timeoutMs) {
      endHandoff();
      handoffTimer = setTimeout(() => {
        // A cancelled press never sends the follow-up: wake the coordinator
        // rather than leave it to its deadline.
        handoffTimer = null;
        notify();
      }, timeoutMs);
    },
    followUpPending: () => handoffTimer !== null,
    onReleased(listener) {
      listeners.add(listener);
    },
  };
}
