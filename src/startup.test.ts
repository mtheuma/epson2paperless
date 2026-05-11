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

import { dispatchScanSession } from "./startup.js";
import { detectVariant } from "./protocol-probe.js";
import { runEsci2Scan, runEsci2ScanOverPlain } from "./esci2/scanner.js";
import { runEsciScan } from "./esci/scanner.js";
import type { Config } from "./config.js";
import type { PaperlessUploadOptions } from "./paperless-upload.js";

const detectVariantMock = vi.mocked(detectVariant);
const runEsci2ScanMock = vi.mocked(runEsci2Scan);
const runEsci2ScanOverPlainMock = vi.mocked(runEsci2ScanOverPlain);
const runEsciScanMock = vi.mocked(runEsciScan);

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
