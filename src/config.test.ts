import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.PRINTER_IP;
    delete process.env.SCAN_DEST_NAME;
    delete process.env.SCAN_DEST_ID;
    delete process.env.OUTPUT_DIR;
    delete process.env.KEEPALIVE_INTERVAL;
    delete process.env.HEALTH_PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.LANGUAGE;
    delete process.env.PREVIEW_ACTION;
    delete process.env.TEMP_DIR;
    delete process.env.SHUTDOWN_TIMEOUT_MS;
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
    expect(config.keepaliveInterval).toBe(500);
    expect(config.healthPort).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.language).toBe("en");
  });

  it("overrides defaults with env vars", () => {
    process.env.PRINTER_IP = "10.0.0.1";
    process.env.SCAN_DEST_NAME = "MyScanner";
    process.env.SCAN_DEST_ID = "05";
    process.env.OUTPUT_DIR = "/scans";
    process.env.KEEPALIVE_INTERVAL = "1000";
    process.env.HEALTH_PORT = "8080";
    process.env.LOG_LEVEL = "debug";
    process.env.LANGUAGE = "de";
    const config = loadConfig();
    expect(config.printerIp).toBe("10.0.0.1");
    expect(config.scanDestName).toBe("MyScanner");
    expect(config.scanDestId).toBe(0x05);
    expect(config.outputDir).toBe("/scans");
    expect(config.keepaliveInterval).toBe(1000);
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
});
