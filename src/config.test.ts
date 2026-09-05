import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  isPaperlessEnabled,
  resolveWireColorMode,
  resolveGrayscaleConversion,
  DEFAULT_JPEG_QUALITY,
} from "./config.js";
import { buildPaperlessOptions } from "./startup.js";

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.PRINTER_IP;
    delete process.env.PRINTER_HOSTNAME;
    delete process.env.SCAN_DEST_NAME;
    delete process.env.SCAN_DEST_ID;
    delete process.env.OUTPUT_DIR;
    delete process.env.HEALTH_PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    delete process.env.LANGUAGE;
    delete process.env.PREVIEW_ACTION;
    delete process.env.SCAN_FORMAT;
    delete process.env.SCAN_SIDES;
    delete process.env.SCAN_RESOLUTION;
    delete process.env.SCAN_COLOR_MODE;
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
    delete process.env.ESCI_FORCE_SOURCE;
    delete process.env.SCAN_TRIGGER_TOKEN;
    delete process.env.NETSCAN_VERSION;
    delete process.env.POST_PROCESS;
    delete process.env.PRINTER_WHITE_POINT;
  });

  it("parses PRINTER_WHITE_POINT into a channel triplet", () => {
    process.env.PRINTER_IP = "192.168.1.5";
    process.env.PRINTER_WHITE_POINT = "227:232:255";
    expect(loadConfig().printerWhitePoint).toEqual([227, 232, 255]);
  });

  it("leaves PRINTER_WHITE_POINT undefined when unset", () => {
    process.env.PRINTER_IP = "192.168.1.5";
    expect(loadConfig().printerWhitePoint).toBeUndefined();
  });

  it("rejects a malformed PRINTER_WHITE_POINT", () => {
    process.env.PRINTER_IP = "192.168.1.5";
    for (const bad of ["227,232,255", "227:232", "227:232:255:1", "ff:ee:dd", "227 232 255"]) {
      process.env.PRINTER_WHITE_POINT = bad;
      expect(() => loadConfig()).toThrow("PRINTER_WHITE_POINT");
    }
  });

  it("rejects an out-of-range PRINTER_WHITE_POINT channel", () => {
    process.env.PRINTER_IP = "192.168.1.5";
    process.env.PRINTER_WHITE_POINT = "227:232:300";
    expect(() => loadConfig()).toThrow("PRINTER_WHITE_POINT");
  });

  it("rejects a PRINTER_WHITE_POINT measured from tinted stock", () => {
    // The likeliest misuse: calibrating from cream paper rather than white,
    // which would over-correct every later scan and push coloured pages
    // toward greyscale. Cream measures roughly this.
    process.env.PRINTER_IP = "192.168.1.5";
    process.env.PRINTER_WHITE_POINT = "247:224:173";
    expect(() => loadConfig()).toThrow("PRINTER_WHITE_POINT");
  });

  it("accepts a realistic scanner cast", () => {
    process.env.PRINTER_IP = "192.168.1.5";
    process.env.PRINTER_WHITE_POINT = "227:232:255"; // ET-4956, spread 28
    expect(loadConfig().printerWhitePoint).toEqual([227, 232, 255]);
  });

  it("rejects a PRINTER_WHITE_POINT too dark to be paper", () => {
    // Guards the likeliest misuse: measuring something other than a blank
    // white sheet, which would apply a large and wrong correction.
    process.env.PRINTER_IP = "192.168.1.5";
    process.env.PRINTER_WHITE_POINT = "60:20:20";
    expect(() => loadConfig()).toThrow("PRINTER_WHITE_POINT");
  });

  it("throws if PRINTER_IP is missing", () => {
    expect(() => loadConfig()).toThrow("PRINTER_IP");
  });

  it("accepts a hostname target", () => {
    process.env.PRINTER_HOSTNAME = "printer.example.lan";
    expect(loadConfig().printerHostname).toBe("printer.example.lan");
  });

  it("accepts a fully-qualified hostname with a trailing dot", () => {
    process.env.PRINTER_HOSTNAME = "printer.home.arpa.";
    expect(loadConfig().printerHostname).toBe("printer.home.arpa.");
  });

  it("rejects both printer target variables", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_HOSTNAME = "printer.example.lan";
    expect(() => loadConfig()).toThrow(/Exactly one/);
  });

  it("rejects malformed hostnames", () => {
    const malformed = [
      "bad host",
      ".example.com",
      "foo..bar",
      "foo.-bar",
      "foo-.bar",
      "-foo.bar",
      "foo.bar-",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(127)}example.com`,
    ];
    for (const hostname of malformed) {
      process.env.PRINTER_HOSTNAME = hostname;
      expect(() => loadConfig()).toThrow(/PRINTER_HOSTNAME/);
    }
  });

  it("rejects all-numeric-dotted hostnames and points at PRINTER_IP", () => {
    for (const hostname of ["0.0.0.0", "192.168.01.1", "10.0.0.1."]) {
      process.env.PRINTER_HOSTNAME = hostname;
      expect(() => loadConfig()).toThrow(/PRINTER_IP/);
    }
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

  // Table-driven octet-range checks. The earlier regex `(\d{1,3}\.){3}\d{1,3}`
  // accepted any 4-component dotted decimal regardless of octet value; that
  // let `999.999.999.999` and similar through, only failing later at socket
  // connect time with a far less helpful error. The tightened regex bounds
  // each octet to 0-255 at config validation.
  it.each([
    ["256.0.0.0", "octet just above max"],
    ["999.999.999.999", "all-out-of-range"],
    ["0.0.0.300", "trailing octet over 255"],
    ["1.2.3", "only three octets"],
    ["1.2.3.4.5", "five components"],
    ["", "empty string"],
    // Leading zeros: Node's dgram.connect() silently resolves these to
    // 0.0.0.0 instead of the intended address, so a confusing "binds to
    // 0.0.0.0" failure appears later in network.ts rather than a clear
    // startup error. Reject at the config layer instead.
    ["001.002.003.004", "leading zeros on every octet"],
    ["192.168.01.1", "leading zero in third octet"],
    ["010.0.0.1", "leading zero in first octet"],
  ])("rejects PRINTER_IP=%s (%s)", (value) => {
    process.env.PRINTER_IP = value;
    expect(() => loadConfig()).toThrow(/PRINTER_IP/);
  });

  it.each([
    ["0.0.0.0", "all zeros"],
    ["255.255.255.255", "all max"],
    ["192.168.1.1", "common LAN"],
    ["10.0.0.255", "broadcast-end"],
  ])("accepts PRINTER_IP=%s (%s)", (value) => {
    process.env.PRINTER_IP = value;
    const config = loadConfig();
    expect(config.printerIp).toBe(value);
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

  it("defaults POST_PROCESS to none", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(loadConfig().postProcess).toBe("none");
  });

  it("accepts POST_PROCESS=document", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.POST_PROCESS = "document";
    expect(loadConfig().postProcess).toBe("document");
  });

  it("rejects an unknown POST_PROCESS", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.POST_PROCESS = "sharpen";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults SCAN_FORMAT to pdf", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(loadConfig().scanFormat).toBe("pdf");
  });

  it("accepts SCAN_FORMAT=jpg", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_FORMAT = "jpg";
    expect(loadConfig().scanFormat).toBe("jpg");
  });

  it("rejects invalid SCAN_FORMAT", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_FORMAT = "preview";
    expect(() => loadConfig()).toThrow();
  });

  it("defaults SCAN_SIDES to duplex", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(loadConfig().scanSides).toBe("duplex");
  });

  it("accepts SCAN_SIDES=simplex", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_SIDES = "simplex";
    expect(loadConfig().scanSides).toBe("simplex");
  });

  it("rejects invalid SCAN_SIDES", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_SIDES = "both";
    expect(() => loadConfig()).toThrow();
  });

  it("leaves scanResolution undefined when SCAN_RESOLUTION is unset", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(loadConfig().scanResolution).toBeUndefined();
  });

  it("accepts any integer in the sanity range (250 is no longer rejected)", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_RESOLUTION = "250";
    expect(loadConfig().scanResolution).toBe(250);
  });

  it("accepts the range bounds 50 and 1200", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_RESOLUTION = "50";
    expect(loadConfig().scanResolution).toBe(50);
    process.env.SCAN_RESOLUTION = "1200";
    expect(loadConfig().scanResolution).toBe(1200);
  });

  it("rejects out-of-range SCAN_RESOLUTION (49, 1201)", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_RESOLUTION = "49";
    expect(() => loadConfig()).toThrow(/SCAN_RESOLUTION/);
    process.env.SCAN_RESOLUTION = "1201";
    expect(() => loadConfig()).toThrow(/SCAN_RESOLUTION/);
  });

  it("defaults SCAN_COLOR_MODE to color", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    expect(loadConfig().scanColorMode).toBe("color");
  });

  it("accepts SCAN_COLOR_MODE=grayscale", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_COLOR_MODE = "grayscale";
    expect(loadConfig().scanColorMode).toBe("grayscale");
  });

  it("accepts SCAN_COLOR_MODE=auto", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_COLOR_MODE = "auto";
    expect(loadConfig().scanColorMode).toBe("auto");
  });

  it("resolveWireColorMode: only an explicit grayscale changes the wire request", () => {
    expect(resolveWireColorMode("color")).toBe("color");
    expect(resolveWireColorMode("grayscale")).toBe("grayscale");
    // "auto" is host-side only: colour on the wire, conversion at finalize.
    expect(resolveWireColorMode("auto")).toBe("color");
    expect(resolveWireColorMode(undefined)).toBe("color");
  });

  it("resolveGrayscaleConversion: grayscale falls back to host-side conversion when the wire can't", () => {
    // Wire honoured the greyscale request (dialect has a monoGammaClass) —
    // pages arrive greyscale already, so converting again would be waste.
    expect(resolveGrayscaleConversion("grayscale", true)).toBe("off");
    // Wire scanned in colour — every page is converted host-side.
    expect(resolveGrayscaleConversion("grayscale", false)).toBe("force");
    // "auto" classifies per page regardless of wire capability.
    expect(resolveGrayscaleConversion("auto", true)).toBe("auto");
    expect(resolveGrayscaleConversion("auto", false)).toBe("auto");
    expect(resolveGrayscaleConversion("color", false)).toBe("off");
    expect(resolveGrayscaleConversion(undefined, false)).toBe("off");
  });

  it("rejects an invalid SCAN_COLOR_MODE", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.SCAN_COLOR_MODE = "mono";
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

  it("defaults JPEG_QUALITY to DEFAULT_JPEG_QUALITY", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.JPEG_QUALITY;
    expect(loadConfig().jpegQuality).toBe(DEFAULT_JPEG_QUALITY);
    expect(DEFAULT_JPEG_QUALITY).toBe(90); // pin the actual value so a drift here is caught explicitly
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

  it("defaults NETSCAN_VERSION to auto", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    expect(loadConfig().netscanVersion).toBe("auto");
  });

  it("accepts NETSCAN_VERSION=3.0 and NETSCAN_VERSION=2.0", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.NETSCAN_VERSION = "3.0";
    expect(loadConfig().netscanVersion).toBe("3.0");
    process.env.NETSCAN_VERSION = "2.0";
    expect(loadConfig().netscanVersion).toBe("2.0");
  });

  it("rejects an unknown NETSCAN_VERSION value", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.NETSCAN_VERSION = "4.0";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects PRINTER_CERT_FINGERPRINT with PRINTER_PROTOCOL=esci", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci";
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

  it("ESCI_FORCE_SOURCE defaults to undefined", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    delete process.env.ESCI_FORCE_SOURCE;
    expect(loadConfig().esciForceSource).toBeUndefined();
  });

  it("ESCI_FORCE_SOURCE accepts flatbed", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.ESCI_FORCE_SOURCE = "flatbed";
    expect(loadConfig().esciForceSource).toBe("flatbed");
  });

  it("ESCI_FORCE_SOURCE rejects invalid values", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.ESCI_FORCE_SOURCE = "garbage";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects ESCI_FORCE_SOURCE with PRINTER_PROTOCOL=esci2", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2";
    process.env.ESCI_FORCE_SOURCE = "flatbed";
    expect(() => loadConfig()).toThrow(/no effect/i);
  });

  it("accepts ESCI_FORCE_SOURCE=adf-simplex", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.ESCI_FORCE_SOURCE = "adf-simplex";
    const config = loadConfig();
    expect(config.esciForceSource).toBe("adf-simplex");
  });

  // ─── PRINTER_PROTOCOL=esci2-plain (ET-2750) ─────────────────────────────

  it("accepts PRINTER_PROTOCOL=esci2-plain", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2-plain";
    const config = loadConfig();
    expect(config.printerProtocol).toBe("esci2-plain");
  });

  it("rejects PRINTER_CERT_FINGERPRINT with PRINTER_PROTOCOL=esci2-plain", () => {
    // ET-2750 has no TLS layer to pin against; reject the combo at
    // startup rather than silently ignoring the fingerprint.
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2-plain";
    process.env.PRINTER_CERT_FINGERPRINT =
      "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
    expect(() => loadConfig()).toThrow(/no TLS layer/i);
  });

  it("rejects ESCI_FORCE_SOURCE with PRINTER_PROTOCOL=esci2-plain", () => {
    // ESC/I-2 (TLS or plain) does its own source detection via
    // INIT_POLL_STAT — the legacy ESCI_FORCE_SOURCE lever doesn't apply.
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2-plain";
    process.env.ESCI_FORCE_SOURCE = "flatbed";
    expect(() => loadConfig()).toThrow(/no effect/i);
  });

  it("accepts PRINTER_PROTOCOL=esci2-plain alongside Paperless config", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.PRINTER_PROTOCOL = "esci2-plain";
    process.env.PAPERLESS_URL = "http://paperless.example/";
    process.env.PAPERLESS_TOKEN = "deadbeef";
    const config = loadConfig();
    expect(config.printerProtocol).toBe("esci2-plain");
    expect(config.paperlessUrl).toBe("http://paperless.example/");
    expect(config.paperlessToken).toBe("deadbeef");
  });

  it("rejects LEGACY_FORCE_SOURCE at startup with a helpful migration error", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.LEGACY_FORCE_SOURCE = "adf-simplex";
    // Old name produces an explicit migration error pointing at the new name.
    expect(() => loadConfig()).toThrow(/LEGACY_FORCE_SOURCE has been renamed to ESCI_FORCE_SOURCE/);
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

  it("accepts PRINTER_PROTOCOL=esci", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_PROTOCOL = "esci";
    const config = loadConfig();
    expect(config.printerProtocol).toBe("esci");
  });

  it("rejects PRINTER_PROTOCOL=legacy with a helpful migration error", () => {
    process.env.PRINTER_IP = "192.0.2.58";
    process.env.PRINTER_PROTOCOL = "legacy";
    // The Zod enum rejects "legacy" since v0.4.0; the error message should
    // mention the new name "esci" so users get a clear migration signal.
    expect(() => loadConfig()).toThrow(/esci/i);
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
    delete process.env.ESCI_FORCE_SOURCE;
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
    delete process.env.PRINTER_HOSTNAME;
    delete process.env.PRINTER_CERT_FINGERPRINT;
    delete process.env.PRINTER_PROTOCOL;
    delete process.env.ESCI_FORCE_SOURCE;
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

describe("SCAN_TRIGGER_TOKEN", () => {
  beforeEach(() => {
    // Earlier blocks leave printer/paperless vars behind; start from a clean slate.
    for (const key of Object.keys(process.env)) {
      if (/^(PRINTER_|PAPERLESS_|SCAN_|PREVIEW_|POST_|ESCI_|LEGACY_|JPEG_|DIAGNOSE_|NETSCAN_|TEMP_DIR|OUTPUT_DIR|HEALTH_PORT|LOG_|LANGUAGE|SHUTDOWN_)/.test(key))
        delete process.env[key];
    }
    process.env.PRINTER_IP = "192.0.2.5";
  });

  it("is undefined when unset (webhook disabled)", () => {
    expect(loadConfig().scanTriggerToken).toBeUndefined();
  });

  it("is undefined when set to the empty string", () => {
    process.env.SCAN_TRIGGER_TOKEN = "";
    expect(loadConfig().scanTriggerToken).toBeUndefined();
  });

  it("carries the token through verbatim", () => {
    process.env.SCAN_TRIGGER_TOKEN = "s3cret-Token_value";
    expect(loadConfig().scanTriggerToken).toBe("s3cret-Token_value");
  });

  it("rejects a whitespace-only token as a misconfiguration", () => {
    process.env.SCAN_TRIGGER_TOKEN = "   ";
    expect(() => loadConfig()).toThrow();
  });
});
