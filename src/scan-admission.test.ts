import { describe, it, expect, vi } from "vitest";
import { createInflightTracker } from "./lifecycle.js";
import { createScanAdmission, createSingleScanAdmission } from "./scan-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const settle = () => new Promise((r) => setImmediate(r));

describe("createScanAdmission", () => {
  it("is idle with nothing tracked and nothing reserved", () => {
    const admission = createScanAdmission(createInflightTracker());
    expect(admission.isBusy()).toBe(false);
  });

  it("is busy while a tracked scan is in flight", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const scan = deferred();
    admission.track(scan.promise);
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
    admission.commit(scan.promise);
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
    admission.commit(scan.promise);
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

  // The gate and the drain answer different questions. Hooks are tracked
  // straight into the tracker for the drain; they must not make the gate
  // refuse the very press they belong to.
  it("a promise tracked for the drain alone leaves the gate idle", () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    void inflight.track(new Promise<void>(() => {}));
    expect(inflight.count).toBe(1);
    expect(admission.isBusy()).toBe(false);
  });
});

describe("createScanAdmission — expectFollowUp", () => {
  // On the FF-680W / DS-575W a press is a JobList, then a PushScan on a fresh
  // connection ~0.7 s later (pcap-measured). The hand-off keeps the drain
  // waiting for that follow-up without gating it (issue #207 review).
  it("keeps the drain waiting without making the gate busy", () => {
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

  it("a hand-off that no press follows ends at its timeout", async () => {
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
