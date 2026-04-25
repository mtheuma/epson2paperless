import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, setLogFormat, setLogLevel } from "./logger.js";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset module-level state between tests so earlier tests don't leak into later ones.
    setLogLevel("debug");
    setLogFormat("text");
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    setLogLevel("info");
    setLogFormat("text");
  });

  describe("text mode (default)", () => {
    it("emits a prefixed line matching 'TS [LEVEL] [module] msg'", () => {
      const log = createLogger("mod");
      log.info("hello");
      expect(logSpy).toHaveBeenCalledOnce();
      const arg = logSpy.mock.calls[0][0];
      expect(arg).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z \[INFO\] \[mod\] hello$/);
    });

    it("passes data as a separate console argument (not concatenated into the message)", () => {
      const log = createLogger("mod");
      log.info("scan done", { pages: 3 });
      expect(logSpy).toHaveBeenCalledWith(
        "%s",
        expect.stringMatching(/\[INFO\] \[mod\] scan done$/),
        { pages: 3 },
      );
    });
  });

  describe("json mode", () => {
    beforeEach(() => {
      setLogFormat("json");
    });

    it("emits a single JSON-parseable line with ts/level/module/msg", () => {
      const log = createLogger("mod");
      log.info("hello");
      expect(logSpy).toHaveBeenCalledOnce();
      const raw = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("mod");
      expect(parsed.msg).toBe("hello");
      expect(typeof parsed.ts).toBe("string");
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z$/);
      expect("data" in parsed).toBe(false);
    });

    it("includes a data field when the caller supplied one", () => {
      const log = createLogger("mod");
      log.info("scan done", { pages: 3 });
      const raw = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.data).toEqual({ pages: 3 });
    });

    it("serialises Error instances to { name, message, stack }", () => {
      const log = createLogger("mod");
      const err = new Error("boom");
      log.error("oops", err);
      const raw = errSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as { data: Record<string, unknown> };
      expect(parsed.data).toMatchObject({ name: "Error", message: "boom" });
      expect(typeof parsed.data.stack).toBe("string");
    });

    it("falls back gracefully on circular references", () => {
      const log = createLogger("mod");
      interface Self {
        marker?: string;
        self?: Self;
      }
      const o: Self = { marker: "visible" };
      o.self = o;
      expect(() => log.info("circular", o)).not.toThrow();
      const raw = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw) as { data: string };
      expect(typeof parsed.data).toBe("string");
      expect(parsed.data).toContain("marker");
      expect(parsed.data).toContain("visible");
      expect(parsed.data).toContain("Circular");
    });

    it("respects level gating", () => {
      setLogLevel("warn");
      const log = createLogger("mod");
      log.info("nope");
      log.debug("nope");
      expect(logSpy).not.toHaveBeenCalled();
      log.warn("yes");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("routes warn/error to stderr and info/debug to stdout", () => {
      const log = createLogger("mod");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
      expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errSpy).toHaveBeenCalledOnce();
    });
  });

  describe("setLogFormat", () => {
    it("toggles behaviour across calls", () => {
      const log = createLogger("mod");

      setLogFormat("text");
      log.info("first");
      expect(logSpy.mock.calls[0][0]).toMatch(/\[INFO\] \[mod\] first$/);

      setLogFormat("json");
      log.info("second");
      const secondRaw = logSpy.mock.calls[1][0] as string;
      expect(() => JSON.parse(secondRaw)).not.toThrow();
      expect((JSON.parse(secondRaw) as { msg: string }).msg).toBe("second");

      setLogFormat("text");
      log.info("third");
      expect(logSpy.mock.calls[2][0]).toMatch(/\[INFO\] \[mod\] third$/);
    });
  });
});
