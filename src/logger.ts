import { inspect } from "node:util";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFormat = "text" | "json";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let currentFormat: LogFormat = "text";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setLogFormat(format: LogFormat): void {
  currentFormat = format;
}

function serialiseData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

function safeInspect(data: unknown): string {
  try {
    return inspect(data, { depth: 4, breakLength: Infinity });
  } catch {
    return Object.prototype.toString.call(data);
  }
}

function log(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const timestamp = new Date().toISOString();
  // warn/error go to stderr so log aggregators can separate them from info stream.
  const sink = level === "warn" ? console.warn : level === "error" ? console.error : console.log;

  if (currentFormat === "json") {
    const record: Record<string, unknown> = { ts: timestamp, level, module, msg: message };
    if (data !== undefined) record.data = serialiseData(data);
    try {
      sink(JSON.stringify(record));
    } catch {
      sink(JSON.stringify({ ...record, data: safeInspect(data) }));
    }
    return;
  }

  const prefix = `${timestamp} [${level.toUpperCase()}] [${module}]`;
  if (data !== undefined) {
    sink(`${prefix} ${message}`, data);
  } else {
    sink(`${prefix} ${message}`);
  }
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => log("debug", module, msg, data),
    info: (msg: string, data?: unknown) => log("info", module, msg, data),
    warn: (msg: string, data?: unknown) => log("warn", module, msg, data),
    error: (msg: string, data?: unknown) => log("error", module, msg, data),
  };
}
