import { vi } from "vitest";
import { getLogLevel, setLogLevel } from "../../logger.js";

export interface CapturedLine {
  /** `log` carries debug + info, `warn` carries warn (the logger's sinks). */
  stream: "log" | "warn";
  /** Prefix + message, e.g. `<ts> [DEBUG] [scanner-esci] Dialect resolved`. */
  text: string;
  data: unknown;
}

/**
 * Capture the logger's text-format output, debug level included, until
 * `restore()`, which puts the previous level back. The logger calls
 * `sink("%s", line, data)` when it has data and `sink(line)` when it has none.
 */
export function captureLogs(): { lines: CapturedLine[]; restore: () => void } {
  const lines: CapturedLine[] = [];
  const record =
    (stream: CapturedLine["stream"]) =>
    (...args: unknown[]): void => {
      if (args[0] === "%s") lines.push({ stream, text: String(args[1]), data: args[2] });
      else lines.push({ stream, text: String(args[0]), data: undefined });
    };
  const previousLevel = getLogLevel();
  setLogLevel("debug");
  const logSpy = vi.spyOn(console, "log").mockImplementation(record("log"));
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(record("warn"));
  return {
    lines,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      setLogLevel(previousLevel);
    },
  };
}
