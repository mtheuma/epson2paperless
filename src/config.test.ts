import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, isPaperlessEnabled } from "./config.js";
import { buildPaperlessOptions } from "./startup.js";

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.PRINTER_IP;
    delete process.env.SCAN_DEST_NAME;
    delete process.env.SCAN_DEST_ID;
    delete process.env.OUTPUT_DIR;
    delete process.env.HEALTH_PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    delete process.env.LANGUAGE;
    delete process.env.PREVIEW_ACTION;
    delete process.env.TEMP_DIR;
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_TOKEN;
    delete process.env.PAPERLESS_TOKEN_FILE;
    delete process.env.PAPERLESS_DELETE_AFTER_UPLOAD;
    delete process.env.PRINTER_CERT_FINGERPRINT;
    delete process.env.JPEG_QUALITY;
    delete process.env.PRINTER_PROTOCOL;
    delete process.env.LEGACY_FORCE_SOURCE;
  });

  it("throws if PRINTER_IP is missing", () => {
    expect(() => loadConfig()).toThrow("PRINTER_IP");
  });

  it("loads required PRINTER_IP and applies defaults", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const config = loadConfig();
    expect(config.printerIp).toBe("192.0.2.58");
    expect(config.scanDestName).toBe("Paperless");
    expect(config.scanDestId).toBe(0x02);
    expect(config.outputDir).toBe("/output");
    expect(config.healthPort).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("text");
    expect(config.language).toBe("en");
  });

  it("overrides defaults with env vars", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.SCAN_DEST_NAME = "MyScanner";
    process.env.SCAN_DEST_ID = "05";
    process.env.OUTPUT_DIR = "/scans";
    process.env.HEALTH_PORT = "8080";
    process.env.LOG_LEVEL = "debug";
    process.env.LANGUAGE = "de";
    const config = loadConfig();
    expect(config.printerIp).toBe("10.0.0.1");
    expect(config.scanDestName).toBe("MyScanner");
    expect(config.scanDestId).toBe(0x05);
    expect(config.outputDir).toBe("/scans");
    expect(config.healthPort).toBe(8080);
    expect(config.logLevel).toBe("debug");
    expect(config.language).toBe("de");
  });

  it("rejects invalid PRINTER_IP", () => {
    process.env.PRINTER_IP = "not-an-ip";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults previewAction to 'reject'", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const config = loadConfig();
    expect(config.previewAction).toBe("reject");
  });

  it("accepts PREVIEW_ACTION=jpg", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PREVIEW_ACTION = "jpg";
    const config = loadConfig();
    expect(config.previewAction).toBe("jpg");
  });

  it("accepts PREVIEW_ACTION=pdf", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PREVIEW_ACTION = "pdf";
    const config = loadConfig();
    expect(config.previewAction).toBe("pdf");
  });

  it("rejects invalid PREVIEW_ACTION", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PREVIEW_ACTION = "invalid";
    expect(() => loadConfig()).toThrow();
  });

  it("accepts LOG_FORMAT=json", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.LOG_FORMAT = "json";
    const config = loadConfig();
    expect(config.logFormat).toBe("json");
  });

  it("rejects invalid LOG_FORMAT", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.LOG_FORMAT = "yaml";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults tempDir to empty string", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const config = loadConfig();
    expect(config.tempDir).toBe("");
  });

  it("accepts TEMP_DIR as an absolute path", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.TEMP_DIR = "/var/tmp/epson";
    const config = loadConfig();
    expect(config.tempDir).toBe("/var/tmp/epson");
  });

  it("defaults shutdownTimeoutMs to 30000", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const config = loadConfig();
    expect(config.shutdownTimeoutMs).toBe(30000);
  });

  it("accepts SHUTDOWN_TIMEOUT_MS override", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SHUTDOWN_TIMEOUT_MS = "5000";
    const config = loadConfig();
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it("rejects invalid SHUTDOWN_TIMEOUT_MS", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SHUTDOWN_TIMEOUT_MS = "not-a-number";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults JPEG_QUALITY to 90", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.JPEG_QUALITY;
    expect(loadConfig().jpegQuality).toBe(90);
  });

  it("accepts a JPEG_QUALITY override", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.JPEG_QUALITY = "75";
    expect(loadConfig().jpegQuality).toBe(75);
  });

  it("rejects JPEG_QUALITY out of range", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.JPEG_QUALITY = "150";
    expect(() => loadConfig()).toThrow();
  });

  it("picks up PAPERLESS_URL + PAPERLESS_TOKEN from env (defaults to delete-after-upload=true)", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    process.env.PAPERLESS_TOKEN = "abc123";
    const config = loadConfig();
    expect(config.paperlessUrl).toBe("http://paperless.lan:8000");
    expect(config.paperlessToken).toBe("abc123");
    expect(config.paperlessDeleteAfterUpload).toBe(true);
  });

  it("PAPERLESS_DELETE_AFTER_UPLOAD=false explicitly opts out of deletion", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    process.env.PAPERLESS_TOKEN = "abc123";
    process.env.PAPERLESS_DELETE_AFTER_UPLOAD = "false";
    const config = loadConfig();
    expect(config.paperlessDeleteAfterUpload).toBe(false);
  });

  it("reads PAPERLESS_TOKEN_FILE from disk and trims whitespace", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const tmp = mkdtempSync(path.join(os.tmpdir(), "paperless-test-"));
    const tokenFile = path.join(tmp, "token");
    try {
      writeFileSync(tokenFile, "  file-token-xyz  \n");
      process.env.PAPERLESS_URL = "http://paperless.lan:8000";
      process.env.PAPERLESS_TOKEN_FILE = tokenFile;
      const config = loadConfig();
      expect(config.paperlessToken).toBe("file-token-xyz");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PAPERLESS_TOKEN_FILE takes precedence over PAPERLESS_TOKEN when both set", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    const tmp = mkdtempSync(path.join(os.tmpdir(), "paperless-test-"));
    const tokenFile = path.join(tmp, "token");
    try {
      writeFileSync(tokenFile, "from-file");
      process.env.PAPERLESS_URL = "http://paperless.lan:8000";
      process.env.PAPERLESS_TOKEN = "from-env";
      process.env.PAPERLESS_TOKEN_FILE = tokenFile;
      const config = loadConfig();
      expect(config.paperlessToken).toBe("from-file");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws at startup when PAPERLESS_TOKEN_FILE points at a nonexistent path", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    process.env.PAPERLESS_TOKEN_FILE = "/definitely/does/not/exist";
    expect(() => loadConfig()).toThrow(/PAPERLESS_TOKEN_FILE/);
  });

  it("isPaperlessEnabled returns false when URL or token is missing", () => {
    process.env.PRINTER_IP = "192.0.2.58";

    // No vars set — both undefined
    let config = loadConfig();
    expect(isPaperlessEnabled(config)).toBe(false);

    // URL only
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    config = loadConfig();
    expect(isPaperlessEnabled(config)).toBe(false);

    // URL + token — enabled
    process.env.PAPERLESS_TOKEN = "abc";
    config = loadConfig();
    expect(isPaperlessEnabled(config)).toBe(true);

    // Token only (url cleared)
    delete process.env.PAPERLESS_URL;
    config = loadConfig();
    expect(isPaperlessEnabled(config)).toBe(false);
  });

  it("defaults PRINTER_PROTOCOL to auto", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.PRINTER_PROTOCOL;
    expect(loadConfig().printerProtocol).toBe("auto");
  });

  it("rejects PRINTER_CERT_FINGERPRINT with PRINTER_PROTOCOL=legacy", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "legacy";
    process.env.PRINTER_CERT_FINGERPRINT =
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    expect(() => loadConfig()).toThrow(/incompatible/i);
  });

  it("rejects PRINTER_CERT_FINGERPRINT with PRINTER_PROTOCOL=auto", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "auto";
    process.env.PRINTER_CERT_FINGERPRINT =
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    expect(() => loadConfig()).toThrow(/PRINTER_PROTOCOL=esci2/);
  });

  it("accepts PRINTER_PROTOCOL=auto without a fingerprint", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "auto";
    expect(loadConfig().printerProtocol).toBe("auto");
    expect(loadConfig().printerCertFingerprint).toBeUndefined();
  });

  it("accepts PRINTER_CERT_FINGERPRINT with PRINTER_PROTOCOL=esci2", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2";
    process.env.PRINTER_CERT_FINGERPRINT =
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    const config = loadConfig();
    expect(config.printerProtocol).toBe("esci2");
    expect(config.printerCertFingerprint).toBe(
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
    );
  });

  it("LEGACY_FORCE_SOURCE defaults to undefined", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.LEGACY_FORCE_SOURCE;
    expect(loadConfig().legacyForceSource).toBeUndefined();
  });

  it("LEGACY_FORCE_SOURCE accepts flatbed", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.LEGACY_FORCE_SOURCE = "flatbed";
    expect(loadConfig().legacyForceSource).toBe("flatbed");
  });

  it("LEGACY_FORCE_SOURCE rejects invalid values", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.LEGACY_FORCE_SOURCE = "garbage";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects LEGACY_FORCE_SOURCE with PRINTER_PROTOCOL=esci2", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2";
    process.env.LEGACY_FORCE_SOURCE = "flatbed";
    expect(() => loadConfig()).toThrow(/no effect/i);
  });

  it("DIAGNOSE_PROTOCOL defaults to false", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.DIAGNOSE_PROTOCOL;
    expect(loadConfig().diagnoseProtocol).toBe(false);
  });

  it("DIAGNOSE_PROTOCOL accepts 'true'", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.DIAGNOSE_PROTOCOL = "true";
    expect(loadConfig().diagnoseProtocol).toBe(true);
    delete process.env.DIAGNOSE_PROTOCOL;
  });

  it("DIAGNOSE_PROTOCOL anything other than 'true' is false", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.DIAGNOSE_PROTOCOL = "yes";
    expect(loadConfig().diagnoseProtocol).toBe(false);
    delete process.env.DIAGNOSE_PROTOCOL;
  });
});

describe("buildPaperlessOptions", () => {
  beforeEach(() => {
    delete process.env.PRINTER_IP;
    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_TOKEN;
    delete process.env.PAPERLESS_TOKEN_FILE;
    delete process.env.PAPERLESS_DELETE_AFTER_UPLOAD;
    delete process.env.PRINTER_PROTOCOL;
    delete process.env.LEGACY_FORCE_SOURCE;
  });

  it("returns undefined when either URL or token is missing", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(buildPaperlessOptions(loadConfig())).toBeUndefined();

    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    expect(buildPaperlessOptions(loadConfig())).toBeUndefined();

    delete process.env.PAPERLESS_URL;
    process.env.PAPERLESS_TOKEN = "abc";
    expect(buildPaperlessOptions(loadConfig())).toBeUndefined();
  });

  it("returns options with deleteAfterUpload=true by default", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    process.env.PAPERLESS_TOKEN = "abc123";
    expect(buildPaperlessOptions(loadConfig())).toEqual({
      url: "http://paperless.lan:8000",
      token: "abc123",
      deleteAfterUpload: true,
    });
  });

  it("honours PAPERLESS_DELETE_AFTER_UPLOAD=false", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PAPERLESS_URL = "http://paperless.lan:8000";
    process.env.PAPERLESS_TOKEN = "abc123";
    process.env.PAPERLESS_DELETE_AFTER_UPLOAD = "false";
    expect(buildPaperlessOptions(loadConfig())).toEqual({
      url: "http://paperless.lan:8000",
      token: "abc123",
      deleteAfterUpload: false,
    });
  });
});

describe("PRINTER_CERT_FINGERPRINT", () => {
  beforeEach(() => {
    delete process.env.PRINTER_IP;
    delete process.env.PRINTER_CERT_FINGERPRINT;
    delete process.env.PRINTER_PROTOCOL;
    delete process.env.LEGACY_FORCE_SOURCE;
  });

  it("accepts a 32-byte uppercase fingerprint", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_PROTOCOL = "esci2";
    process.env.PRINTER_CERT_FINGERPRINT =
      "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78";
    const config = loadConfig();
    expect(config.printerCertFingerprint).toBe(
      "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78",
    );
  });

  it("normalises lowercase to uppercase", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_PROTOCOL = "esci2";
    process.env.PRINTER_CERT_FINGERPRINT =
      "ab:cd:ef:01:23:45:67:89:0a:bc:de:f0:12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0:12:34:56:78";
    const config = loadConfig();
    expect(config.printerCertFingerprint).toBe(
      "AB:CD:EF:01:23:45:67:89:0A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78",
    );
  });

  it("rejects a malformed fingerprint", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_CERT_FINGERPRINT = "AB:CD:EF"; // too short
    expect(() => loadConfig()).toThrow(/PRINTER_CERT_FINGERPRINT/);
  });
});
