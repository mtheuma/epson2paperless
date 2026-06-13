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
vi.mock("./ff680w-job-control.js", () => ({
  runFf680wJobListCommit: vi.fn(() => Promise.resolve()),
  runFf680wJobNumberCommit: vi.fn(() => Promise.resolve(Buffer.from("0300020000020001", "hex"))),
}));

import {
  buildPushScanServerOptions,
  dispatchScanSession,
  logStartupBanner,
  resolveScanDispatch,
} from "./startup.js";
import { detectVariant } from "./protocol-probe.js";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./esci2/scanner.js";
import { runEsciScan } from "./esci/scanner.js";
import { runFf680wJobListCommit, runFf680wJobNumberCommit } from "./ff680w-job-control.js";
import type { Config } from "./config.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";
import { setLogFormat, setLogLevel } from "./logger.js";
import type { PushScanInfo } from "./pushscan.js";

const detectVariantMock = vi.mocked(detectVariant);
const runEsci2ScanMock = vi.mocked(runEsci2Scan);
const runEsci2ScanOverPlainMock = vi.mocked(runEsci2ScanOverPlain);
const runEsciScanMock = vi.mocked(runEsciScan);
const runFf680wJobListCommitMock = vi.mocked(runFf680wJobListCommit);
const runFf680wJobNumberCommitMock = vi.mocked(runFf680wJobNumberCommit);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    printerIp: "192.0.2.5",
    scanDestName: "Paperless",
    scanDestId: 0x02,
    outputDir: "/test-output",
    healthPort: 3000,
    logLevel: "info",
    logFormat: "text",
    language: "en",
    jpegQuality: 90,
    previewAction: "reject",
    scanFormat: "pdf",
    scanSides: "duplex",
    scanResolution: 200,
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
  productName: "PID 016B",
  ipAddress: "C0A80A08",
  duplex: false,
  action: "unknown",
};

describe("logStartupBanner", () => {
  beforeEach(() => {
    setLogLevel("info");
    setLogFormat("text");
  });

  it("warns when SCAN_DEST_NAME is 15 UTF-8 bytes or longer", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      setLogLevel("warn");
      logStartupBanner(makeConfig({ scanDestName: "123456789012345" }), "starting");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "SCAN_DEST_NAME is 15 bytes; Epson discovery may reject names 15 bytes or longer",
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("resolveScanDispatch", () => {
  it("uses JOB_NUMBER_ACTION for FF-680W-style JobNumberIn scans without PushScanIDIn", () => {
    expect(resolveScanDispatch(FF680W_JOB_NUMBER_INFO, makeConfig({ scanFormat: "jpg" }))).toEqual({
      duplex: true,
      action: "jpg",
    });
  });
});

describe("buildPushScanServerOptions", () => {
  beforeEach(() => {
    runFf680wJobListCommitMock.mockReset().mockResolvedValue(undefined);
    runFf680wJobNumberCommitMock
      .mockReset()
      .mockResolvedValue(Buffer.from("0300020000020001", "hex"));
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

    expect(runFf680wJobListCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.20" });
    expect(runFf680wJobNumberCommitMock).not.toHaveBeenCalled();
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

    expect(runFf680wJobNumberCommitMock).toHaveBeenCalledWith({ printerIp: "203.0.113.21" });
    expect(runFf680wJobListCommitMock).not.toHaveBeenCalled();
  });

  it("does not run FF-680W job-control for other products", async () => {
    const options = buildPushScanServerOptions(makeConfig());

    await options.beforeResponse?.({
      kind: "jobList",
      headers: "",
      body: "",
      xuid: "6",
      info: { ...FF680W_JOB_NUMBER_INFO, productName: "PID 11D1" },
      capabilities: ["OfficeFormat"],
    });

    expect(runFf680wJobListCommitMock).not.toHaveBeenCalled();
    expect(runFf680wJobNumberCommitMock).not.toHaveBeenCalled();
  });
});

describe("dispatchScanSession", () => {
  beforeEach(() => {
    detectVariantMock.mockReset();
    runEsci2ScanMock.mockReset().mockResolvedValue(undefined);
    runEsci2ScanOverPlainMock.mockReset().mockResolvedValue(undefined);
    runEsciScanMock.mockReset().mockResolvedValue(undefined);
  });

  it("forwards the configured override + IP to detectVariant", async () => {
    detectVariantMock.mockResolvedValue("esci2");
    const config = makeConfig({ printerProtocol: "esci2", printerIp: "203.0.113.7" });
    await dispatchScanSession({ config, duplex: false, action: "jpg", paperless: undefined });

    expect(detectVariantMock).toHaveBeenCalledTimes(1);
    expect(detectVariantMock).toHaveBeenCalledWith({
      printerIp: "203.0.113.7",
      port: 1865,
      override: "esci2",
      timeoutMs: 3000,
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
      resolution: 200,
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
    });

    expect(runEsciScanMock).toHaveBeenCalledTimes(1);
    expect(runEsci2ScanMock).not.toHaveBeenCalled();
    expect(runEsci2ScanOverPlainMock).not.toHaveBeenCalled();
    expect(runEsciScanMock).toHaveBeenCalledWith({
      printerIp: "192.0.2.5",
      port: 1865,
      outputDir: "/test-output",
      tempDir: "",
      duplex: true,
      forcedSource: "adf-duplex",
      format: "pdf",
      jpegQuality: 75,
      paperless: PAPERLESS_OPTS,
      diagnoseProtocol: true,
    });
  });

  it("variant=esci passes forcedSource=null when esciForceSource is unset", async () => {
    detectVariantMock.mockResolvedValue("esci");
    const config = makeConfig({ printerProtocol: "esci" });
    await dispatchScanSession({ config, duplex: false, action: "jpg", paperless: undefined });

    const call = runEsciScanMock.mock.calls[0][0];
    expect(call.forcedSource).toBeNull();
  });

  it("propagates scanner rejection to the caller", async () => {
    detectVariantMock.mockResolvedValue("esci2");
    const boom = new Error("scan failed");
    runEsci2ScanMock.mockRejectedValueOnce(boom);
    const config = makeConfig({ printerProtocol: "esci2" });

    await expect(
      dispatchScanSession({ config, duplex: false, action: "jpg", paperless: undefined }),
    ).rejects.toThrow("scan failed");
  });
});
