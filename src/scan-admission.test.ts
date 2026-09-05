import { describe, it, expect } from "vitest";
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
  it("is idle before any trigger is admitted", () => {
    const admission = createSingleScanAdmission();
    expect(admission.isBusy()).toBe(false);
  });

  it("is busy from reserve() until the reservation is released", () => {
    const admission = createSingleScanAdmission();
    const release = admission.reserve();
    expect(admission.isBusy()).toBe(true);
    release();
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

  it("a stale release hook cannot drop a newer reservation", () => {
    const admission = createSingleScanAdmission();
    const staleRelease = admission.reserve();
    admission.release();
    admission.reserve();
    staleRelease();
    expect(admission.isBusy()).toBe(true);
  });
});
