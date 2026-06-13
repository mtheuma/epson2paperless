import { readFileSync } from "node:fs";
import { runEsci2Scan } from "../scanner.js";
import { FakeTlsSocket } from "./fake-tls-socket.js";

function waitImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface CaptureRecord {
  hook: "startup" | "waiting" | "send" | "recv" | "error" | "async_event";
  type_hex?: string;
  payload_hex?: string;
  payload_size?: number;
}

export function readJsonl(filePath: string): CaptureRecord[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CaptureRecord);
}

/**
 * Trim the driver's variable STAT-cycle count to a fixed `keep`, matching the
 * scanner. The driver runs ~12 STAT heartbeat cycles after two capability-
 * discovery cycles; our scanner runs 3. Each STAT cycle is exactly 9 capture
 * records (3 sends + 6 recvs: envelope header + body per send). We keep the
 * first `keep` driver STAT cycles, drop the rest, and resume at FS X.
 *
 * Pre-STAT sends: LOCK (1) + cycle 1 (6) + cycle 2 (8) = 15 sends. The STAT
 * loop begins at the 16th send → sendIndices[15].
 */
export function trimStatCycles(records: CaptureRecord[], keep: number): CaptureRecord[] {
  const sendIndices = records.map((r, i) => (r.hook === "send" ? i : -1)).filter((i) => i !== -1);
  if (sendIndices.length < 16) {
    throw new Error(`trimStatCycles: capture has only ${sendIndices.length} sends, expected ≥ 16`);
  }
  const statLoopStart = sendIndices[15];
  const fsXRecord = records.findIndex((r) => r.hook === "send" && r.payload_hex?.endsWith("1c58"));
  if (fsXRecord === -1) {
    throw new Error("trimStatCycles: no FS X send found (payload ending 1c58)");
  }
  // Detect cycle size by measuring from the first STAT-cycle send (sendIndices[15])
  // to the second STAT-cycle send (sendIndices[16 + sendsPerCycle - 1]).
  // Each cycle starts with a FS Y send; count total records until the next FS Y
  // send to determine recordsPerStatCycle. FS Y payload ends in "1c59".
  const fsYPayload = records[statLoopStart].payload_hex ?? "";
  const nextCycleStart = records.findIndex(
    (r, i) => i > statLoopStart && r.hook === "send" && (r.payload_hex ?? "") === fsYPayload,
  );
  if (nextCycleStart === -1) {
    throw new Error(
      "trimStatCycles: could not detect STAT cycle boundary (no second FS Y matching first)",
    );
  }
  const recordsPerStatCycle = nextCycleStart - statLoopStart;
  const trimmedStatEnd = statLoopStart + keep * recordsPerStatCycle;
  if (trimmedStatEnd > fsXRecord) {
    // keep is larger than the capture actually has; the two slices would overlap
    // and duplicate FS X plus the whole image phase. Fail clearly instead.
    throw new Error(
      `trimStatCycles: keep=${keep} exceeds the capture's STAT cycle count ` +
        `(trimmed end ${trimmedStatEnd} would overlap FS X at ${fsXRecord})`,
    );
  }
  return [...records.slice(0, trimmedStatEnd), ...records.slice(fsXRecord)];
}

/** Default replay connection params. The captured ET-4950 session is host-only
 *  (a FakeTlsSocket), so these are placeholders, but the baseline records them
 *  and a baseline can override them via ReplayOptions. */
export const REPLAY_PRINTER_IP = "192.0.2.58";
export const REPLAY_DEST_ID = 0x02;

export interface ReplayOptions {
  printerIp?: string;
  destId?: number;
}

export interface ReplayResult {
  totalDriverSends: number;
  scannerWrites: Buffer[];
  sessionPromise: Promise<void>;
}

/**
 * Drive the scanner through a (pre-trimmed) captured session.
 * Feeds every `recv` record as bytes and waits for the scanner's matching nth
 * write. Returns after the records are exhausted. Byte-for-byte assertion of
 * each scanner write against the captured `send` bytes is the caller's job —
 * this helper deliberately contains no `expect` calls so it can be reused
 * outside Vitest (e.g. a dev replay CLI).
 */
export async function replayCapture(
  records: CaptureRecord[],
  outputDir: string,
  duplex: boolean,
  action: "jpg" | "pdf",
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const filtered = records.filter((r) => r.hook === "send" || r.hook === "recv");
  const fake = new FakeTlsSocket();

  const sessionPromise = runEsci2Scan(
    {
      printerIp: opts.printerIp ?? REPLAY_PRINTER_IP,
      port: 1865,
      destId: opts.destId ?? REPLAY_DEST_ID,
      outputDir,
      tempDir: "",
      duplex,
      action,
    },
    fake.asFactory(),
  );
  fake.simulateConnect();

  let expectedSendIdx = 0;
  for (const rec of filtered) {
    if (rec.hook === "recv") {
      fake.feed(Buffer.from(rec.payload_hex ?? "", "hex"));
      await waitImmediate();
    } else {
      // Wait for the scanner to produce this write — handles the engine's
      // async flushPage barrier (multi-microtask: await encode → file I/O →
      // unpause → write staged send) without hard-coding tick counts.
      await fake.waitForWriteCount(expectedSendIdx + 1);
      expectedSendIdx++;
    }
  }

  // Let the DONE-path finalization task run to completion.
  await waitImmediate();
  await waitImmediate();

  const totalDriverSends = filtered.filter((r) => r.hook === "send").length;
  return { totalDriverSends, scannerWrites: fake.writes, sessionPromise };
}
