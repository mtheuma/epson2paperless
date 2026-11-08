import { describe, it, expect, vi } from "vitest";
import { createInflightTracker } from "./lifecycle.js";
import { createScanAdmission, createSingleScanAdmission } from "./scan-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const settle = () => new Promise((r) => setImmediate(r));
/** A scan session that never reports its end: the scan's own settle frees the slot. */
const sessionOpen = new Promise<void>(() => {});

describe("createScanAdmission", () => {
  it("is idle with nothing tracked and nothing reserved", () => {
    const admission = createScanAdmission(createInflightTracker());
    expect(admission.isBusy()).toBe(false);
  });

  it("is busy while a tracked scan is in flight", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const scan = deferred();
    admission.track(scan.promise, sessionOpen);
    expect(admission.isBusy()).toBe(true);
    scan.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);
  });

  it("is busy from reserve() until the reservation is released", () => {
    const admission = createScanAdmission(createInflightTracker());
    const release = admission.reserve();
    expect(admission.isBusy()).toBe(true);
    release();
    expect(admission.isBusy()).toBe(false);
  });

  it("commit() tracks the scan and drops the reservation with no idle gap", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.reserve();
    const scan = deferred();
    admission.commit(scan.promise, sessionOpen);
    expect(admission.isBusy()).toBe(true);
    await settle(); // the hold's tracker entry settles; the scan remains
    expect(inflight.count).toBe(1);
    expect(admission.isBusy()).toBe(true);
    scan.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);
  });

  it("release() on the admission drops the current reservation (dispatch skipped)", () => {
    const admission = createScanAdmission(createInflightTracker());
    admission.reserve();
    admission.release();
    expect(admission.isBusy()).toBe(false);
  });

  it("a stale release hook cannot drop a newer reservation", () => {
    const admission = createScanAdmission(createInflightTracker());
    const staleRelease = admission.reserve();
    admission.release(); // first trigger abandoned
    admission.reserve(); // second trigger admitted
    staleRelease(); // late close of the first socket
    expect(admission.isBusy()).toBe(true);
  });

  it("release hooks are idempotent", () => {
    const admission = createScanAdmission(createInflightTracker());
    const release = admission.reserve();
    release();
    release();
    expect(admission.isBusy()).toBe(false);
  });

  // The hold is itself an inflight promise, so the daemon's shutdown drain
  // waits out the admission→callback gap with no extra coordinator (issue
  // #207). These pin the tracker's view of the hold.
  it("reserve() registers the hold with the tracker until it is released", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const release = admission.reserve();
    expect(inflight.count).toBe(1);
    release();
    await settle();
    expect(inflight.count).toBe(0);
  });

  it("commit() never lets the tracker read empty between the hold and the scan", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.reserve();
    expect(inflight.count).toBe(1);
    const scan = deferred();
    admission.commit(scan.promise, sessionOpen);
    // The scan is tracked before the hold settles: both are present for a
    // microtask, and a drain that snapshotted the hold sees the scan next.
    expect(inflight.count).toBe(2);
    await settle();
    expect(inflight.count).toBe(1);
    scan.resolve();
    await settle();
    expect(inflight.count).toBe(0);
  });

  it("a stale release hook does not settle a newer reservation's hold", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const staleRelease = admission.reserve();
    admission.release(); // first trigger abandoned
    admission.reserve(); // second trigger admitted
    await settle();
    staleRelease(); // late close of the first socket
    await settle();
    expect(inflight.count).toBe(1);
    expect(admission.isBusy()).toBe(true);
  });

  // The admission check and the drain answer different questions. Hooks are
  // tracked straight into the tracker for the drain; they must not make
  // admission refuse the very trigger they belong to.
  it("a promise tracked for the drain alone leaves admission idle", () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    void inflight.track(new Promise<void>(() => {}));
    expect(inflight.count).toBe(1);
    expect(admission.isBusy()).toBe(false);
  });
});

// Issue #155: a scan holds the slot for its scan session only. Its output and
// Paperless upload run on afterwards, and the next scan must not wait for them.
describe("createScanAdmission — scan session end", () => {
  it("frees the slot when the session ends, keeping the scan tracked for the drain", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.reserve();
    const scan = deferred();
    const session = deferred();
    admission.commit(scan.promise, session.promise);
    await settle();
    expect(admission.isBusy()).toBe(true);
    session.resolve(); // the printer is done; the upload is still running
    await settle();
    expect(admission.isBusy()).toBe(false);
    expect(inflight.count).toBe(1);
    scan.resolve();
    await settle();
    expect(inflight.count).toBe(0);
  });

  it("frees the slot when the scan settles before any session ends", async () => {
    const admission = createScanAdmission(createInflightTracker());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      admission.track(Promise.reject(new Error("probe failed")), sessionOpen);
      await settle();
      expect(admission.isBusy()).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("admits the next scan while the previous one finishes its upload", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const first = deferred();
    const firstSession = deferred();
    admission.track(first.promise, firstSession.promise);
    firstSession.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);

    const second = deferred();
    admission.track(second.promise, sessionOpen);
    expect(admission.isBusy()).toBe(true);
    expect(inflight.count).toBe(2);
    // The first scan's upload finishing must not free the second scan's slot.
    first.resolve();
    await settle();
    expect(admission.isBusy()).toBe(true);
    second.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);
  });

  // During the shutdown drain the listener stays open (issue #207), so a scan
  // that is only uploading must keep the slot, or a press would start a scan
  // the drain then has to wait for or cut off.
  it("keeps the slot until the scan settles once the drain has begun", async () => {
    const admission = createScanAdmission(createInflightTracker());
    const scan = deferred();
    const session = deferred();
    admission.track(scan.promise, session.promise);
    session.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);
    admission.beginDrain();
    expect(admission.isBusy()).toBe(true);
    scan.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false); // a JobList's follow-up is still admitted
  });
});

describe("createScanAdmission — expectFollowUp", () => {
  // On the FF-680W / DS-575W a JobList comes first and the panel trigger, a
  // PushScan, follows on a fresh connection ~0.7 s later (pcap-measured). The
  // hand-off keeps the drain waiting for it without making admission busy (issue #207 review).
  it("keeps the drain waiting without making admission busy", () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.expectFollowUp(1000);
    expect(inflight.count).toBe(1);
    expect(admission.isBusy()).toBe(false);
  });

  it("the next reserve() ends the hand-off with no gap in the tracker", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.expectFollowUp(1000);
    admission.reserve();
    expect(inflight.count).toBe(2); // hold tracked before the hand-off settles
    expect(admission.isBusy()).toBe(true);
    await settle();
    expect(inflight.count).toBe(1);
  });

  it("a hand-off that no trigger follows ends at its timeout", async () => {
    vi.useFakeTimers();
    try {
      const inflight = createInflightTracker();
      const admission = createScanAdmission(inflight);
      admission.expectFollowUp(50);
      await vi.advanceTimersByTimeAsync(49);
      expect(inflight.count).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(inflight.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second JobList replaces the hand-off rather than stacking one", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    admission.expectFollowUp(1000);
    admission.expectFollowUp(1000);
    await settle();
    expect(inflight.count).toBe(1);
  });
});

describe("createSingleScanAdmission", () => {
  // The reservation slot is shared with createScanAdmission and pinned above;
  // these cover only what is different: the commit latch.
  it("is idle before any trigger is admitted", () => {
    const admission = createSingleScanAdmission();
    expect(admission.isBusy()).toBe(false);
  });

  it("release() on the admission drops the current reservation (dispatch skipped)", () => {
    const admission = createSingleScanAdmission();
    admission.reserve();
    admission.release();
    expect(admission.isBusy()).toBe(false);
  });

  it("commit() keeps the slot busy for good, even after the release hook fires", () => {
    const admission = createSingleScanAdmission();
    const release = admission.reserve();
    admission.commit();
    expect(admission.isBusy()).toBe(true);
    release();
    expect(admission.isBusy()).toBe(true);
    admission.release();
    expect(admission.isBusy()).toBe(true);
  });
});

describe("createSingleScanAdmission — onReleased", () => {
  // One-shot's shutdown coordinator waits on this instead of polling isBusy():
  // a signal landing in the admission→callback gap has to learn promptly that
  // the trigger ended (issue #202).
  it("fires when release() drops the reservation", () => {
    const admission = createSingleScanAdmission();
    const listener = vi.fn();
    admission.onReleased(listener);
    admission.reserve();
    admission.release();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fires when the trigger's own release hook drops the reservation", () => {
    const admission = createSingleScanAdmission();
    const listener = vi.fn();
    admission.onReleased(listener);
    const release = admission.reserve();
    release();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a stale release hook that drops nothing", () => {
    const admission = createSingleScanAdmission();
    const staleRelease = admission.reserve();
    admission.release(); // first trigger abandoned
    const listener = vi.fn();
    admission.onReleased(listener);
    admission.reserve(); // second trigger admitted
    staleRelease(); // late close of the first socket
    expect(listener).not.toHaveBeenCalled();
    expect(admission.isBusy()).toBe(true);
  });

  it("does not fire on commit(), nor on a hook that runs after it", () => {
    const admission = createSingleScanAdmission();
    const listener = vi.fn();
    admission.onReleased(listener);
    const release = admission.reserve();
    admission.commit();
    release();
    admission.release();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not fire when nothing is reserved", () => {
    const admission = createSingleScanAdmission();
    const listener = vi.fn();
    admission.onReleased(listener);
    admission.release();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createSingleScanAdmission — expectFollowUp", () => {
  // Same JobList → PushScan hand-off as the daemon's, seen from one-shot's
  // coordinator (issue #209): the follow-up arrives on a fresh connection
  // ~0.7 s after the JobList is answered, with no hook and no hold in flight.
  it("reports the hand-off as pending without making admission busy", () => {
    const admission = createSingleScanAdmission();
    expect(admission.followUpPending()).toBe(false);
    admission.expectFollowUp(1000);
    expect(admission.followUpPending()).toBe(true);
    expect(admission.isBusy()).toBe(false);
  });

  it("the next reserve() ends the hand-off", () => {
    const admission = createSingleScanAdmission();
    admission.expectFollowUp(1000);
    admission.reserve();
    expect(admission.followUpPending()).toBe(false);
    expect(admission.isBusy()).toBe(true);
  });

  it("a second JobList replaces the hand-off rather than stacking one", () => {
    vi.useFakeTimers();
    try {
      const admission = createSingleScanAdmission();
      admission.expectFollowUp(50);
      vi.advanceTimersByTime(40);
      admission.expectFollowUp(50);
      vi.advanceTimersByTime(40); // the first would have lapsed by now
      expect(admission.followUpPending()).toBe(true);
      vi.advanceTimersByTime(10);
      expect(admission.followUpPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hand-off that no trigger follows lapses at its timeout", () => {
    vi.useFakeTimers();
    try {
      const admission = createSingleScanAdmission();
      admission.expectFollowUp(50);
      vi.advanceTimersByTime(49);
      expect(admission.followUpPending()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(admission.followUpPending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cancelling on the panel after the JobList means no follow-up PushScan. The
  // coordinator waits on onReleased, so a lapse wakes it rather than leaving it to its deadline.
  it("a lapsed hand-off fires onReleased listeners", () => {
    vi.useFakeTimers();
    try {
      const admission = createSingleScanAdmission();
      const listener = vi.fn();
      admission.onReleased(listener);
      admission.expectFollowUp(50);
      vi.advanceTimersByTime(49);
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hand-off ended by reserve() or replaced by a newer one does not fire onReleased", () => {
    vi.useFakeTimers();
    try {
      const admission = createSingleScanAdmission();
      const listener = vi.fn();
      admission.onReleased(listener);
      admission.expectFollowUp(50);
      admission.expectFollowUp(50);
      admission.reserve();
      vi.advanceTimersByTime(100);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timer does not keep the process alive once committed", () => {
    vi.useFakeTimers();
    try {
      const admission = createSingleScanAdmission();
      const listener = vi.fn();
      admission.onReleased(listener);
      admission.expectFollowUp(50);
      admission.reserve();
      admission.commit();
      vi.advanceTimersByTime(100);
      expect(listener).not.toHaveBeenCalled();
      expect(admission.isBusy()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
