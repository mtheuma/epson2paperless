import net from "node:net";
import {
  buildIsPacket,
  buildLockPacket,
  buildUnlockPacket,
  parseIsPacket,
  type IsPacket,
} from "./protocol.js";
import { createLogger } from "./logger.js";

const log = createLogger("ff680w-job");

const DEFAULT_JOB_CONTROL_PORT = 1865;
const DEFAULT_TIMEOUT_MS = 3000;
const JOB_LOCK_TIMEOUT_SECONDS = 30;
// Sanity cap on a declared IS payload length. Job-control replies are a handful
// of bytes; anything past this signals a desynced stream, so fail fast instead
// of blocking read() until the timeout.
const MAX_JOB_REPLY_PAYLOAD = 65536;

export type Ff680wJobSocketFactory = (host: string, port: number) => net.Socket;

export interface Ff680wJobControlOptions {
  printerIp: string;
  port?: number;
  timeoutMs?: number;
  socketFactory?: Ff680wJobSocketFactory;
}

const JOBW_DUMMY_COMMAND = Buffer.from(
  "4a4f425700000000000000000000000000000000011a18000000000a0000440075006d006d00790003000000020000020100",
  "hex",
);
const JOBR_COMMAND = Buffer.from("JOBR", "ascii");

export function buildJobPacket(command: Buffer, replySize: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(command.length, 0);
  header.writeUInt32BE(replySize, 4);
  return buildIsPacket(0x2300, Buffer.concat([header, command]));
}

export function buildFf680wDummyJobWritePacket(): Buffer {
  return buildJobPacket(JOBW_DUMMY_COMMAND, 0);
}

export function buildFf680wJobReadPacket(): Buffer {
  return buildJobPacket(JOBR_COMMAND, 8);
}

export async function runFf680wJobListCommit(opts: Ff680wJobControlOptions): Promise<void> {
  await runJobControl(opts, buildFf680wDummyJobWritePacket(), 0, "JOBW");
}

export async function runFf680wJobNumberCommit(opts: Ff680wJobControlOptions): Promise<Buffer> {
  return runJobControl(opts, buildFf680wJobReadPacket(), 8, "JOBR");
}

async function runJobControl(
  opts: Ff680wJobControlOptions,
  jobPacket: Buffer,
  expectedReplyBytes: number,
  label: "JOBW" | "JOBR",
): Promise<Buffer> {
  const port = opts.port ?? DEFAULT_JOB_CONTROL_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketFactory = opts.socketFactory ?? ((host, p) => net.connect(p, host));
  const socket = socketFactory(opts.printerIp, port);
  const reader = new IsPacketReader(socket, timeoutMs);
  let locked = false;

  try {
    await waitForConnect(socket, timeoutMs, label);

    await expectPacket(reader, 0x8000, `${label} welcome`);
    socket.write(buildLockPacket(JOB_LOCK_TIMEOUT_SECONDS));

    await expectPacket(reader, 0xa100, `${label} lock ack`, (packet) => packet.payload[0] === 0x06);
    locked = true;
    socket.write(jobPacket);

    const jobReply = await expectPacket(reader, 0xa300, `${label} reply`);
    if (jobReply.payload.length !== expectedReplyBytes) {
      throw new Error(
        `${label} reply payload length ${jobReply.payload.length}, expected ${expectedReplyBytes}`,
      );
    }

    socket.write(buildUnlockPacket());
    await expectPacket(reader, 0xa101, `${label} unlock ack`);
    locked = false;
    socket.end();

    log.debug(`${label} control transaction completed`);
    return Buffer.from(jobReply.payload);
  } catch (err) {
    // If we acquired the lock but failed before unlocking, best-effort send an
    // UNLOCK so the printer doesn't sit locked for JOB_LOCK_TIMEOUT_SECONDS and
    // reject the scan-session lock that opens on this same port moments later.
    // end() flushes the UNLOCK then half-closes; fall back to destroy on throw.
    if (locked && !socket.destroyed) {
      try {
        socket.end(buildUnlockPacket());
      } catch {
        socket.destroy();
      }
    } else {
      socket.destroy(err instanceof Error ? err : undefined);
    }
    throw err;
  } finally {
    reader.dispose();
  }
}

class IsPacketReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {}

  async read(label: string): Promise<IsPacket> {
    while (true) {
      this.assertSanePrefix(label);
      const packet = parseIsPacket(this.buffer);
      if (packet !== null) {
        this.buffer = this.buffer.subarray(packet.totalSize);
        return packet;
      }

      const chunk = await waitForData(this.socket, this.timeoutMs, label);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  dispose(): void {
    this.buffer = Buffer.alloc(0);
  }

  private assertSanePrefix(label: string): void {
    if (this.buffer.length >= 2 && (this.buffer[0] !== 0x49 || this.buffer[1] !== 0x53)) {
      throw new Error(
        `${label}: expected IS packet, got ${this.buffer.subarray(0, 2).toString("hex")}`,
      );
    }
    // Once the 12-byte IS header is buffered, sanity-cap the declared payload
    // length (offset 6, BE u32). Job-control replies are tiny; a wild size from
    // a desynced/corrupt stream would otherwise make read() block on more data
    // until the timeout. Fail fast with a clear framing error instead.
    if (this.buffer.length >= 12) {
      const declared = this.buffer.readUInt32BE(6);
      if (declared > MAX_JOB_REPLY_PAYLOAD) {
        throw new Error(
          `${label}: IS payload length ${declared} exceeds ${MAX_JOB_REPLY_PAYLOAD} — framing desync`,
        );
      }
    }
  }
}

async function expectPacket(
  reader: IsPacketReader,
  type: number,
  label: string,
  validate?: (packet: IsPacket) => boolean,
): Promise<IsPacket> {
  const packet = await reader.read(label);
  if (packet.type !== type) {
    throw new Error(`${label}: expected IS 0x${hex(type)}, got 0x${hex(packet.type)}`);
  }
  if (validate && !validate(packet)) {
    throw new Error(`${label}: invalid payload ${packet.payload.toString("hex")}`);
  }
  return packet;
}

function waitForConnect(socket: net.Socket, timeoutMs: number, label: string): Promise<void> {
  if (socket.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label}: socket closed before connect`));
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForData(socket: net.Socket, timeoutMs: number, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: read timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label}: socket closed before packet arrived`));
    };

    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function hex(n: number): string {
  return n.toString(16).padStart(4, "0");
}
