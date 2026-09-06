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
