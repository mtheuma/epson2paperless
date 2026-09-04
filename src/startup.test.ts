import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./protocol-probe.js", () => ({
  detectVariant: vi.fn(),
}));
vi.mock("./esci2/scanner.js", () => ({
  runEsci2Scan: vi.fn(() => Promise.resolve()),
  runEsci2ScanOverPlain: vi.fn(() => Promise.resolve()),
}));
vi.mock("./esci/scanner.js", () => ({
  runEsciScan: vi.fn(() => Promise.resolve()),
}));
vi.mock("./job-control.js", () => ({
  runJobListCommit: vi.fn(() => Promise.resolve()),
  runJobNumberCommit: vi.fn(() => Promise.resolve(Buffer.from("0300020000020001", "hex"))),
}));

import { buildPushScanServerOptions, dispatchScanSession, resolveScanDispatch } from "./startup.js";
import { detectVariant } from "./protocol-probe.js";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./esci2/scanner.js";
import { runEsciScan } from "./esci/scanner.js";
import { WF3620_ENTRY } from "./esci/dialects/wf3620.js";
import { runJobListCommit, runJobNumberCommit } from "./job-control.js";
import type { Config } from "./config.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";
import type { PushScanInfo } from "./pushscan.js";
import { PID_FF680W, PID_DS575W, PID_ET7700 } from "./printer-ids.js";

const detectVariantMock = vi.mocked(detectVariant);
const runEsci2ScanMock = vi.mocked(runEsci2Scan);
const runEsci2ScanOverPlainMock = vi.mocked(runEsci2ScanOverPlain);
const runEsciScanMock = vi.mocked(runEsciScan);
const runJobListCommitMock = vi.mocked(runJobListCommit);
const runJobNumberCommitMock = vi.mocked(runJobNumberCommit);

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
    ...overrides,
  };
}

const PAPERLESS_OPTS: PaperlessUploadOptions = {
  url: "http://paperless.test",
  token: "test-token",
  deleteAfterUpload: true,
};

const FF680W_JOB_NUMBER_INFO: PushScanInfo = {
  pushScanId: null,
  jobNumber: "0",
  productName: PID_FF680W,
  ipAddress: "C0A80A08",
  duplex: false,
  action: "unknown",
};

// DS-575W (issue #128) is a button-only sibling of the FF-680W that drives the
// same JobList → JobNumber job-control handshake, under its own PID 0169.
const DS575W_JOB_NUMBER_INFO: PushScanInfo = {
  ...FF680W_JOB_NUMBER_INFO,
  productName: PID_DS575W,
};

describe("resolveScanDispatch", () => {
  it("uses SCAN_FORMAT + SCAN_SIDES for FF-680W-style JobNumberIn scans (duplex)", () => {
    expect(
      resolveScanDispatch(
        FF680W_JOB_NUMBER_INFO,
        makeConfig({ scanFormat: "jpg", scanSides: "duplex" }),
      ),
    ).toEqual({ duplex: true, action: "jpg" });
  });

  it("honours SCAN_SIDES=simplex for the job-number flow", () => {
    expect(
      resolveScanDispatch(
        FF680W_JOB_NUMBER_INFO,
        makeConfig({ scanFormat: "pdf", scanSides: "simplex" }),
      ),
    ).toEqual({ duplex: false, action: "pdf" });
  });

  it("still prefers panel PushScanIDIn when present (panel printers)", () => {
    // Panel precedence guard: info.duplex and config.scanSides are set to OPPOSITE
    // values so duplex:true can only come from the panel branch (info.duplex), not
    // the job-number branch (which would yield config.scanSides==="duplex" → false).
    const panelInfo = {
      ...FF680W_JOB_NUMBER_INFO,
      pushScanId: "01",
      action: "pdf" as const,
      duplex: true,
    };
    expect(resolveScanDispatch(panelInfo, makeConfig({ scanSides: "simplex" }))).toEqual({
      duplex: true,
      action: "pdf",
    });
  });

  it("uses SCAN_FORMAT + SCAN_SIDES for the DS-575W job-number flow (PID 0169)", () => {
    expect(
      resolveScanDispatch(
        DS575W_JOB_NUMBER_INFO,
        makeConfig({ scanFormat: "pdf", scanSides: "duplex" }),
      ),
    ).toEqual({ duplex: true, action: "pdf" });
  });

  it("refuses a JobNumberIn scan from a non-job-control product (no guessing)", () => {
    // Only the job-control scanners (FF-680W, DS-575W) fall back to config
    // defaults; any other product that sends JobNumberIn without a PushScanIDIn
    // is ignored.
    const otherInfo = { ...FF680W_JOB_NUMBER_INFO, productName: "PID 11D1" };
    expect(resolveScanDispatch(otherInfo, makeConfig())).toBeNull();
  });
});

describe("buildPushScanServerOptions", () => {
  beforeEach(() => {
    runJobListCommitMock.mockReset().mockResolvedValue(undefined);
    runJobNumberCommitMock.mockReset().mockResolvedValue(Buffer.from("0300020000020001", "hex"));
  });

  it("runs the FF-680W JOBW commit before replying to JobList", async () => {
    const options = buildPushScanServerOptions(makeConfig({ printerIp: "203.0.113.20" }));

    await options.beforeResponse?.({
      kind: "jobList",
      headers: "",
      body: "",
      xuid: "4",
      info: { ...FF680W_JOB_NUMBER_INFO, jobNumber: null },
      capabilities: ["OfficeFormat"],
    });

    expect(runJobListCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.20" });
    expect(runJobNumberCommitMock).not.toHaveBeenCalled();
  });

  it("runs the FF-680W JOBR commit before replying to JobNumberIn PushScan", async () => {
    const options = buildPushScanServerOptions(makeConfig({ printerIp: "203.0.113.21" }));

    await options.beforeResponse?.({
      kind: "pushScan",
      headers: "",
      body: "",
      xuid: "5",
      info: FF680W_JOB_NUMBER_INFO,
      capabilities: [],
    });

    expect(runJobNumberCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.21" });
    expect(runJobListCommitMock).not.toHaveBeenCalled();
  });

  it("runs the JOBR commit for the DS-575W JobNumberIn PushScan (PID 0169)", async () => {
    const options = buildPushScanServerOptions(makeConfig({ printerIp: "203.0.113.23" }));

    await options.beforeResponse?.({
      kind: "pushScan",
      headers: "",
      body: "",
      xuid: "8",
      info: DS575W_JOB_NUMBER_INFO,
      capabilities: [],
    });

    expect(runJobNumberCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.23" });
    expect(runJobListCommitMock).not.toHaveBeenCalled();
  });

  it("runs the JOBW commit for the DS-575W JobList (PID 0169)", async () => {
    const options = buildPushScanServerOptions(makeConfig({ printerIp: "203.0.113.22" }));

    await options.beforeResponse?.({
      kind: "jobList",
      headers: "",
      body: "",
      xuid: "7",
      info: { ...DS575W_JOB_NUMBER_INFO, jobNumber: null },
      capabilities: ["OfficeFormat"],
    });

    expect(runJobListCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.22" });
    expect(runJobNumberCommitMock).not.toHaveBeenCalled();
  });

  it("does not run job-control for other products", async () => {
    const options = buildPushScanServerOptions(makeConfig());

    await options.beforeResponse?.({
      kind: "jobList",
      headers: "",
      body: "",
      xuid: "6",
      info: { ...FF680W_JOB_NUMBER_INFO, productName: "PID 11D1" },
      capabilities: ["OfficeFormat"],
    });

    expect(runJobListCommitMock).not.toHaveBeenCalled();
    expect(runJobNumberCommitMock).not.toHaveBeenCalled();
  });
});

describe("dispatchScanSession", () => {
  beforeEach(() => {
    detectVariantMock.mockReset();
    runEsci2ScanMock.mockReset().mockResolvedValue(undefined);
    runEsci2ScanOverPlainMock.mockReset().mockResolvedValue(undefined);
    runEsciScanMock.mockReset().mockResolvedValue(undefined);
  });

  it("forwards the configured override, IP and push-scan PID to detectVariant", async () => {
    // The exact-object assertion pins the full call shape, including the PID
    // threading the probe's hint depends on (the ET-7700 welcomes with the
    // legacy-shaped 0x02 discriminator, so the probe needs the PID to route
    // it correctly).
    detectVariantMock.mockResolvedValue("esci2");
    const config = makeConfig({ printerProtocol: "esci2", printerIp: "203.0.113.7" });
    await dispatchScanSession({
      config,
      printerIp: "203.0.113.7",
      duplex: false,
      action: "jpg",
      paperless: undefined,
      productName: PID_ET7700,
    });

    expect(detectVariantMock).toHaveBeenCalledTimes(1);
    expect(detectVariantMock).toHaveBeenCalledWith({
      printerIp: "203.0.113.7",
      port: 1865,
      override: "esci2",
      timeoutMs: 3000,
      productName: PID_ET7700,
    });
  });

  it("variant=esci2 routes to runEsci2Scan with cert fingerprint threaded through", async () => {
    detectVariantMock.mockResolvedValue("esci2");
    const fp =
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    const config = makeConfig({
      printerProtocol: "esci2",
      printerCertFingerprint: fp,
      tempDir: "/tmp/scan",
      scanDestId: 0x05,
    });
    await dispatchScanSession({
      config,
      duplex: true,
      action: "pdf",
      paperless: PAPERLESS_OPTS,
      productName: null,
    });

    expect(runEsci2ScanMock).toHaveBeenCalledTimes(1);
    expect(runEsci2ScanOverPlainMock).not.toHaveBeenCalled();
    expect(runEsciScanMock).not.toHaveBeenCalled();
    expect(runEsci2ScanMock).toHaveBeenCalledWith({
      printerIp: "192.0.2.5",
      port: 1865,
      destId: 0x05,
      outputDir: "/test-output",
      tempDir: "/tmp/scan",
      duplex: true,
      action: "pdf",
      postProcess: "none",
      jpegQuality: 90,
      resolution: 200,
      colorMode: "color",
      paperless: PAPERLESS_OPTS,
      printerCertFingerprint: fp,
    });
  });

  it("variant=esci2-plain routes to runEsci2ScanOverPlain WITHOUT cert fingerprint", async () => {
    detectVariantMock.mockResolvedValue("esci2-plain");
    const config = makeConfig({ printerProtocol: "esci2-plain" });
    await dispatchScanSession({
      config,
      duplex: false,
      action: "jpg",
      paperless: PAPERLESS_OPTS,
      productName: null,
    });

    expect(runEsci2ScanOverPlainMock).toHaveBeenCalledTimes(1);
    expect(runEsci2ScanMock).not.toHaveBeenCalled();
    expect(runEsciScanMock).not.toHaveBeenCalled();
    const call = runEsci2ScanOverPlainMock.mock.calls[0][0];
    expect(call).not.toHaveProperty("printerCertFingerprint");
    expect(call.paperless).toBe(PAPERLESS_OPTS);
    expect(call.duplex).toBe(false);
    expect(call.action).toBe("jpg");
    expect(call.resolution).toBe(200);
    expect(call.colorMode).toBe("color");
  });

  it("forwards SCAN_COLOR_MODE=grayscale to both ESC/I-2 scanners", async () => {
    // esci2-plain — the DS-575W's actual path.
    detectVariantMock.mockResolvedValue("esci2-plain");
    await dispatchScanSession({
      config: makeConfig({ printerProtocol: "esci2-plain", scanColorMode: "grayscale" }),
      duplex: false,
      action: "pdf",
      paperless: undefined,
      productName: null,
    });
    expect(runEsci2ScanOverPlainMock.mock.calls[0][0].colorMode).toBe("grayscale");

    // esci2 over TLS takes the same session shape.
    detectVariantMock.mockResolvedValue("esci2");
    await dispatchScanSession({
      config: makeConfig({ printerProtocol: "esci2", scanColorMode: "grayscale" }),
      duplex: false,
      action: "pdf",
      paperless: undefined,
      productName: null,
    });
    expect(runEsci2ScanMock.mock.calls[0][0].colorMode).toBe("grayscale");

    // Legacy has no greyscale wire request at all — the dispatcher resolves
    // grayscale to a forced host-side conversion at finalize.
    detectVariantMock.mockResolvedValue("esci");
    await dispatchScanSession({
      config: makeConfig({ printerProtocol: "esci", scanColorMode: "grayscale" }),
      duplex: false,
      action: "pdf",
      paperless: undefined,
      productName: null,
    });
    expect(runEsciScanMock.mock.calls[0][0].grayscaleConversion).toBe("force");
  });

  it("forwards SCAN_COLOR_MODE=auto: colorMode to ESC/I-2, grayscaleConversion to the legacy arm", async () => {
    detectVariantMock.mockResolvedValue("esci2-plain");
    await dispatchScanSession({
      config: makeConfig({ printerProtocol: "esci2-plain", scanColorMode: "auto" }),
      duplex: false,
      action: "pdf",
      paperless: undefined,
      productName: null,
    });
    // The shell maps "auto" to a colour wire request + per-page host-side conversion.
    expect(runEsci2ScanOverPlainMock.mock.calls[0][0].colorMode).toBe("auto");

    // Legacy has no colour-mode wire axis; only the post-processing mode arrives.
    detectVariantMock.mockResolvedValue("esci");
    await dispatchScanSession({
      config: makeConfig({ printerProtocol: "esci", scanColorMode: "auto" }),
      duplex: false,
      action: "pdf",
      paperless: undefined,
      productName: null,
    });
    expect(runEsciScanMock.mock.calls[0][0].grayscaleConversion).toBe("auto");
  });

  it("variant=esci routes to runEsciScan with forcedSource + jpegQuality + diagnoseProtocol", async () => {
    detectVariantMock.mockResolvedValue("esci");
    const config = makeConfig({
      printerProtocol: "esci",
      esciForceSource: "adf-duplex",
      jpegQuality: 75,
      diagnoseProtocol: true,
    });
    await dispatchScanSession({
      config,
      duplex: true,
      action: "pdf",
      paperless: PAPERLESS_OPTS,
      productName: null,
    });

    expect(runEsciScanMock).toHaveBeenCalledTimes(1);
    expect(runEsci2ScanMock).not.toHaveBeenCalled();
    expect(runEsci2ScanOverPlainMock).not.toHaveBeenCalled();
    expect(runEsciScanMock).toHaveBeenCalledWith({
      printerIp: "192.0.2.5",
      port: 1865,
      outputDir: "/test-output",
      tempDir: "",
      entry: WF3620_ENTRY,
      duplex: true,
      forcedSource: "adf-duplex",
      format: "pdf",
      jpegQuality: 75,
      resolution: 200,
      postProcess: "none",
      grayscaleConversion: "off",
      paperless: PAPERLESS_OPTS,
      diagnoseProtocol: true,
    });
  });

  it("variant=esci passes forcedSource=null when esciForceSource is unset", async () => {
    detectVariantMock.mockResolvedValue("esci");
    const config = makeConfig({ printerProtocol: "esci" });
    await dispatchScanSession({
      config,
      duplex: false,
      action: "jpg",
      paperless: undefined,
      productName: null,
    });

    const call = runEsciScanMock.mock.calls[0][0];
    expect(call.forcedSource).toBeNull();
  });

  it("variant=esci routes XP-620 PID to the xp620 dialect entry", async () => {
    detectVariantMock.mockResolvedValue("esci");
    const config = makeConfig({ printerProtocol: "esci" });
    await dispatchScanSession({
      config,
      duplex: false,
      action: "jpg",
      paperless: undefined,
      productName: "PID 08C8",
    });

    expect(runEsciScanMock).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ name: "xp620" }) }),
    );
  });

  it("propagates scanner rejection to the caller", async () => {
    detectVariantMock.mockResolvedValue("esci2");
    const boom = new Error("scan failed");
    runEsci2ScanMock.mockRejectedValueOnce(boom);
    const config = makeConfig({ printerProtocol: "esci2" });

    await expect(
      dispatchScanSession({
        config,
        duplex: false,
        action: "jpg",
        paperless: undefined,
        productName: null,
      }),
    ).rejects.toThrow("scan failed");
  });
});

/**
 * Hostname mode has no configured literal to fall back on, so the
 * kernel-observed push-scan peer is the only routing input there is. A
 * button-only scan touches it three times, not once — JOBW and JOBR in
 * beforeResponse, then the dispatch — and every one of them has to land on the
 * same address, or the job-control round-trips and the scan itself would talk
 * to different hosts.
 */
describe("observed-peer propagation (DS-575W button scan, hostname mode)", () => {
  const OBSERVED = "192.0.2.77";

  beforeEach(() => {
    runJobListCommitMock.mockReset().mockResolvedValue(undefined);
    runJobNumberCommitMock.mockReset().mockResolvedValue(Buffer.from("0300020000020001", "hex"));
    detectVariantMock.mockReset().mockResolvedValue("esci2-plain");
    runEsci2ScanOverPlainMock.mockReset().mockResolvedValue(undefined);
  });

  it("routes JOBW, JOBR and the scan itself to the observed peer", async () => {
    const config = makeConfig({ printerIp: undefined, printerHostname: "scanner.lan" });
    const options = buildPushScanServerOptions(config);

    // 1. JobList → the JOBW commit opens its own TCP/1865 round-trip.
    await options.beforeResponse?.({
      kind: "jobList",
      headers: "",
      body: "",
      xuid: "9",
      info: { ...DS575W_JOB_NUMBER_INFO, jobNumber: null },
      capabilities: ["OfficeFormat"],
      peerAddress: OBSERVED,
    });

    // 2. JobNumberIn PushScan → the JOBR commit, a second round-trip.
    await options.beforeResponse?.({
      kind: "pushScan",
      headers: "",
      body: "",
      xuid: "10",
      info: DS575W_JOB_NUMBER_INFO,
      capabilities: [],
      peerAddress: OBSERVED,
    });

    // 3. The scan session.
    await dispatchScanSession({
      config,
      duplex: true,
      action: "pdf",
      paperless: undefined,
      productName: PID_DS575W,
      printerIp: OBSERVED,
    });

    expect(runJobListCommitMock).toHaveBeenCalledTimes(1);
    expect(runJobListCommitMock).toHaveBeenCalledWith({ printerIp: OBSERVED });
    expect(runJobNumberCommitMock).toHaveBeenCalledTimes(1);
    expect(runJobNumberCommitMock).toHaveBeenCalledWith({ printerIp: OBSERVED });

    // The probe and the scanner share dispatchScanSession's single resolution,
    // so the routing address can't diverge between deciding the variant and
    // running it.
    expect(detectVariantMock).toHaveBeenCalledTimes(1);
    expect(detectVariantMock.mock.calls[0][0]).toMatchObject({ printerIp: OBSERVED });
    expect(runEsci2ScanOverPlainMock).toHaveBeenCalledTimes(1);
    expect(runEsci2ScanOverPlainMock.mock.calls[0][0]).toMatchObject({ printerIp: OBSERVED });
  });

  it("has nothing to fall back on when the peer is missing in hostname mode", async () => {
    // The corollary of the above: with no PRINTER_IP configured, dropping the
    // observed peer is a hard error, never a silent guess at an address.
    const config = makeConfig({ printerIp: undefined, printerHostname: "scanner.lan" });
    const options = buildPushScanServerOptions(config);

    await expect(
      options.beforeResponse?.({
        kind: "jobList",
        headers: "",
        body: "",
        xuid: "11",
        info: { ...DS575W_JOB_NUMBER_INFO, jobNumber: null },
        capabilities: ["OfficeFormat"],
      }),
    ).rejects.toThrow(/peer address is required/);

    await expect(
      dispatchScanSession({
        config,
        duplex: true,
        action: "pdf",
        paperless: undefined,
        productName: PID_DS575W,
      }),
    ).rejects.toThrow(/No printer address/);
  });
});
