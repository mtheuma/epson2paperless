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
}

/**
 * The reservation itself, shared by both admissions below. Each reserve()
 * mints a fresh token so a hook from an earlier, abandoned trigger cannot
 * drop a newer trigger's hold.
 */
function createReservationSlot() {
  let current: symbol | null = null;
  return {
    held: (): boolean => current !== null,
    reserve: (): (() => void) => {
      const token = Symbol("scan-reservation");
      current = token;
      return () => {
        if (current === token) current = null;
      };
    },
    clear: (): void => {
      current = null;
    },
  };
}

export function createScanAdmission(inflight: InflightTracker): ScanAdmission {
  const slot = createReservationSlot();

  return {
    isBusy: () => slot.held() || inflight.count > 0,
    reserve: slot.reserve,
    commit(scan) {
      // Track before clearing so isBusy() never reads false in between.
      void inflight.track(scan);
      slot.clear();
    },
    release: slot.clear,
    track(scan) {
      void inflight.track(scan);
    },
  };
}

/**
 * One-shot's variant (issue #198): the process serves exactly one scan and
 * then exits, so once a trigger is committed the slot stays busy for good.
 * Same reservation for the gap between `beforeResponse` and the callback,
 * but there is no tracker to consult: the scan's own lifetime is owned by
 * `runScanNowLifecycle`.
 */
export interface SingleScanAdmission extends Pick<ScanAdmission, "isBusy" | "reserve" | "release"> {
  /** The admitted trigger became the scan. Nothing reopens the slot after this. */
  commit(): void;
}

export function createSingleScanAdmission(): SingleScanAdmission {
  const slot = createReservationSlot();
  let committed = false;

  return {
    isBusy: () => committed || slot.held(),
    reserve: slot.reserve,
    commit() {
      committed = true;
    },
    release: slot.clear,
  };
}
