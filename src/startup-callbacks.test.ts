// The two entry points' onPushScan callbacks (issue #200). Neither index.ts
// nor one-shot.ts is importable under test — both run main() on import — so
// before this file the daemon callback was only ever re-implemented inline in
// scan-webhook.test.ts and one-shot's was not covered at all: deleting its
// admission.commit() or the release on the reject path left the suite green.
// Everything here is real except the scan dispatch, which is injected.
import { describe, it, expect, vi, beforeEach } from "vitest";

// setLastScanTime is module-level state in health.ts with no getter, so spy on
// it: the daemon stamps /health's lastScan on every accepted panel trigger and
// one-shot (which runs no health server) must not.
vi.mock("./health.js", async (importActual) => ({
  ...(await importActual<typeof import("./health.js")>()),
  setLastScanTime: vi.fn(),
}));

import { buildDaemonPushScanCallback, buildOneShotPushScanCallback } from "./startup.js";
import { setLastScanTime } from "./health.js";
import { createScanAdmission, createSingleScanAdmission } from "./scan-admission.js";
import { createInflightTracker } from "./lifecycle.js";
import type { Config } from "./config.js";
import type { DispatchArgs } from "./startup.js";
import type { PushScanInfo } from "./pushscan.js";

const setLastScanTimeMock = vi.mocked(setLastScanTime);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    printerIp: "192.0.2.5",
    printerHostname: undefined,
    scanDestName: "Paperless",
    scanDestId: 0x02,
    outputDir: "/test-output",
    healthPort: 3000,
    logLevel: "info",
    logFormat: "text",
    language: "en",
    jpegQuality: 90,
    previewAction: "reject",
    postProcess: "none",
    scanFormat: "pdf",
    scanSides: "duplex",
    scanResolution: 200,
    scanColorMode: "color",
    printerProtocol: "auto",
    diagnoseProtocol: false,
    tempDir: "",
    shutdownTimeoutMs: 30000,
    paperlessDeleteAfterUpload: true,
    paperlessUrl: "http://paperless.test",
    paperlessToken: "test-token",
    ...overrides,
  };
}

/** A panel press: 2-sided off, Action=PDF, from a non-job-control model. */
const PANEL_INFO: PushScanInfo = {
  pushScanId: "02",
  jobNumber: null,
  productName: "PID 11D1",
  ipAddress: "C0A8013A",
  duplex: true,
  action: "pdf",
};

/**
 * Action=Preview with PREVIEW_ACTION=reject (the default): resolveScanDispatch
 * returns null, so the trigger was admitted but will never scan.
 */
const PREVIEW_INFO: PushScanInfo = { ...PANEL_INFO, action: "preview" };

const PEER = "203.0.113.9";

const settle = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The dispatch args both callbacks must build for PANEL_INFO. */
const expectedArgs = (config: Config) => ({
  config,
  duplex: true,
  action: "pdf",
  paperless: {
    url: "http://paperless.test",
    token: "test-token",
    deleteAfterUpload: true,
  },
  productName: "PID 11D1",
  printerIp: PEER,
});

beforeEach(() => {
  setLastScanTimeMock.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("buildDaemonPushScanCallback", () => {
  it("dispatches the panel's scan and converts the reservation into a tracked scan", async () => {
    const inflight = createInflightTracker();
    const admission = createScanAdmission(inflight);
    const scan = deferred();
    const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(() => scan.promise);
    const config = makeConfig();

    // Mirrors the real hand-off: beforeResponse admitted the trigger and holds
    // the slot; the callback runs once the OK has been flushed.
    admission.reserve();
    buildDaemonPushScanCallback({ config, admission, dispatch })(PANEL_INFO, PEER);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expectedArgs(config));
    expect(setLastScanTimeMock).toHaveBeenCalledTimes(1);

    // commit() really tracked the promise: busy while it runs, idle after.
    expect(admission.isBusy()).toBe(true);
    expect(inflight.count).toBe(1);
    scan.resolve();
    await settle();
    expect(admission.isBusy()).toBe(false);
    expect(inflight.count).toBe(0);
  });

  it("releases the reservation and dispatches nothing when the trigger resolves to no scan", () => {
    const admission = createScanAdmission(createInflightTracker());
    const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(() => Promise.resolve());

    admission.reserve();
    buildDaemonPushScanCallback({ config: makeConfig(), admission, dispatch })(PREVIEW_INFO, PEER);

    expect(dispatch).not.toHaveBeenCalled();
    expect(setLastScanTimeMock).not.toHaveBeenCalled();
    // Nothing else would ever drop this hold, so the next trigger would be
    // refused for good (issue #137's gate is shared with POST /scan).
    expect(admission.isBusy()).toBe(false);
  });
});

describe("buildOneShotPushScanCallback", () => {
  it("dispatches the first accepted trigger and holds the slot for the rest of the process", async () => {
    const admission = createSingleScanAdmission();
    const scan = deferred();
    const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(() => scan.promise);
    const started = vi.fn<(started: { scan: Promise<void> }) => void>();
    const config = makeConfig();

    const release = admission.reserve();
    buildOneShotPushScanCallback({ config, admission, onScanStarted: started, dispatch })(
      PANEL_INFO,
      PEER,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expectedArgs(config));
    // The started signal carries the dispatch promise itself, wrapped so the
    // waiter resolves at scan *start*, not at scan end.
    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0][0].scan).toBe(dispatch.mock.results[0].value);
    // One-shot never runs a health server, so nothing stamps lastScan.
    expect(setLastScanTimeMock).not.toHaveBeenCalled();

    // commit() is permanent here: this process serves one scan and exits, so
    // the slot must not reopen. Drop the reservation to prove the hold is the
    // commit's and not merely a hand-off token nobody got round to clearing —
    // without commit() the gate would reopen the moment it went (issue #198).
    expect(admission.isBusy()).toBe(true);
    release();
    expect(admission.isBusy()).toBe(true);
    scan.resolve();
    await settle();
    expect(admission.isBusy()).toBe(true);
  });

  it("releases the reservation and starts nothing when the trigger resolves to no scan", () => {
    const admission = createSingleScanAdmission();
    const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(() => Promise.resolve());
    const started = vi.fn<(started: { scan: Promise<void> }) => void>();

    admission.reserve();
    buildOneShotPushScanCallback({
      config: makeConfig(),
      admission,
      onScanStarted: started,
      dispatch,
    })(PREVIEW_INFO, PEER);

    expect(dispatch).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    // The panel can press again: this trigger never became the one scan.
    expect(admission.isBusy()).toBe(false);
  });

  it("ignores a second accepted trigger without touching the first scan", () => {
    const admission = createSingleScanAdmission();
    const dispatch = vi.fn<(args: DispatchArgs) => Promise<void>>(
      () => new Promise<void>(() => {}),
    );
    const started = vi.fn<(started: { scan: Promise<void> }) => void>();
    const callback = buildOneShotPushScanCallback({
      config: makeConfig(),
      admission,
      onScanStarted: started,
      dispatch,
    });

    admission.reserve();
    callback(PANEL_INFO, PEER);
    // beforeResponse normally refuses this one, so reaching the callback twice
    // takes a race; the duplicate guard is the backstop. onScanStarted is a
    // promise resolver — calling it twice would silently drop the second scan.
    callback(PANEL_INFO, PEER);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(admission.isBusy()).toBe(true);
  });
});
