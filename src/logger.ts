type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function log(level: LogLevel, module: string, message: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}] [${module}]`;
  // warn/error go to stderr so log aggregators can separate them from info stream.
  const sink = level === "warn" ? console.warn : level === "error" ? console.error : console.log;

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
