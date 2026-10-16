import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runEsci2ScanOverPlain } from "./scanner.js";
import { FakePlainSocket } from "./test-support/fake-plain-socket.js";
import { loadFixture, driveFixture, extractScannerParaWrite } from "./test-support/replay.js";
import { readInit1Bodies } from "./test-support/capability-bodies.js";
import { parseCapaTokens, parseInfoTokens } from "./capabilities.js";
import { buildGenericEntry, genericParaFields } from "./dialects/generic.js";
import { makeParaSpec } from "./dialects/dispatch.js";
import { composePara, baseDpiFor } from "./para-composer.js";
import { advertisedDpiSet, selectWireDpi } from "./resolution.js";

// Replays real printer streams through the generic dialect: the registry is
// emptied for this file, so no fixture model resolves its own entry. The
// printer side is canned, so this proves the session runs the generic
// dialect through the settings exchange and on to completion, not that a
// printer would accept its PARA. Only fixtures whose recorded poll count
// matches the generic one (3 with a flatbed, 12 ADF-only) can replay: the
// ET-2750 (2) and FF-680W (8) can't.
vi.mock("./dialects/registry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./dialects/registry.js")>();
  return { ...real, REGISTRY_ENTRIES: [] };
});

const FIXTURES = [
  ["ET-4800", "et-4800/flatbed-jpg", "flatbed"],
  ["ET-4800", "et-4800/adf-jpg", "adf-simplex"],
  ["XP-7100", "xp-7100/jpg-flatbed", "flatbed"],
  ["ET-7700", "et-7700/flatbed-jpg", "flatbed"],
  ["DS-575W", "ds-575w/adf-simplex-400-mono-jpg", "adf-simplex"],
] as const;

describe("generic dialect — fixture replay with every override ignored", () => {
  let outputDir: string;
  let tempDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "generic-out-"));
    tempDir = mkdtempSync(path.join(os.tmpdir(), "generic-tmp-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(FIXTURES)(
    "%s %s",
    async (_model, file, source) => {
      const fixturePath = path.join("tools", "pcap-extract", "captures", `${file}.jsonl`);
      const fake = new FakePlainSocket();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const session = runEsci2ScanOverPlain(
          {
            printerIp: "10.0.0.2",
            port: 1865,
            destId: 0x02,
            outputDir,
            tempDir,
            duplex: false,
            action: "jpg",
          },
          fake.asFactory(),
        );
        await driveFixture(loadFixture(fixturePath), fake, session);
        expect(warn.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
          "not recognised — generic ESC/I-2 dialect, experimental, please report",
        );
      } finally {
        warn.mockRestore();
        log.mockRestore();
      }

      // The PARA sent is the generic one, for the source the session detected.
      const bodies = readInit1Bodies(fixturePath);
      const info = parseInfoTokens(bodies.info);
      const capa = parseCapaTokens(bodies.capa);
      const entry = buildGenericEntry(info, capa);
      const dpi = selectWireDpi(
        baseDpiFor(entry.paraProfile),
        advertisedDpiSet(capa, source),
      ).wireDpi;
      const spec = {
        ...makeParaSpec(entry, source, "jpg", dpi),
        ...genericParaFields(entry),
      };
      expect(extractScannerParaWrite(fake).equals(composePara(spec))).toBe(true);
    },
    60_000,
  );
});
