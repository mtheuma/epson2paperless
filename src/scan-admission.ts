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

export function createScanAdmission(inflight: InflightTracker): ScanAdmission {
  let current: symbol | null = null;

  return {
    isBusy: () => current !== null || inflight.count > 0,
    reserve() {
      const token = Symbol("scan-reservation");
      current = token;
      return () => {
        if (current === token) current = null;
      };
    },
    commit(scan) {
      // Track before clearing so isBusy() never reads false in between.
      void inflight.track(scan);
      current = null;
    },
    release() {
      current = null;
    },
    track(scan) {
      void inflight.track(scan);
    },
  };
}
