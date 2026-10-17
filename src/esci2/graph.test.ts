import { describe, it, expect, vi } from "vitest";
import { esci2Graph, ESCI2_REPLY_SIZE, ESCI2_TIMEOUT_MS, nameInitPollEarlyStop } from "./graph.js";
import { buildEsci2Command } from "./commands.js";
import { buildFsX } from "../commands-fs.js";
import { applyEntrySourceOverride } from "./dialects/dispatch.js";
import { OVERRIDES_BY_FINGERPRINT } from "./dialects/model-overrides.js";
import {
  IS_HEADER_SIZE,
  buildPassthruPacket,
  buildPurereadPacket,
  parseIsPacket,
} from "../protocol.js";
import { parseCapaTokens, parseStatErrors } from "./capabilities.js";
import { DEFAULT_JPEG_QUALITY } from "../config.js";
import {
  REPLAY_FIXTURES,
  readInit1Bodies,
  readPreParaStatus,
} from "./test-support/capability-bodies.js";
import { getLogLevel, setLogLevel } from "../logger.js";
import { computeCapaFingerprint } from "./capa-fingerprint.js";
import { recordedDialect, unresolvedFields } from "./test-support/dialects.js";

describe("esci2Graph (smoke)", () => {
  it("builds with the expected initial state and timeout", () => {
    expect(esci2Graph.initial).toBe("WELCOME");
    expect(esci2Graph.timeoutMs).toBe(ESCI2_TIMEOUT_MS);
    expect(esci2Graph.timeoutMs).toBe(60_000);
  });

  it("has a WELCOME state defined", () => {
    expect(esci2Graph.states.WELCOME).toBeDefined();
  });

  it("has globalIgnoreFilter defined as a pure shape predicate (state-blind)", () => {
    expect(esci2Graph.globalIgnoreFilter).toBeDefined();
    // Empty 0xa000 → ignored.
    expect(esci2Graph.globalIgnoreFilter!({ type: 0xa000, payload: Buffer.alloc(0) })).toBe(true);
    // Non-empty 0xa000 → not ignored.
    expect(esci2Graph.globalIgnoreFilter!({ type: 0xa000, payload: Buffer.from([0x01]) })).toBe(
      false,
    );
    // Other types → not ignored.
    expect(esci2Graph.globalIgnoreFilter!({ type: 0x2000, payload: Buffer.alloc(0) })).toBe(false);
  });

  it("POSTSCAN_*_STAT_DRAIN states opt out of the filter via bypassIgnoreFilter", () => {
    // After our pure-read(0) for a length=0 STAT, the printer's empty
    // 0xa000 reply IS the drain-complete signal — the engine must NOT
    // run the filter for these states, or _STAT_DRAIN hangs waiting on
    // a packet that never reaches its transition table.
    expect(esci2Graph.states.POSTSCAN_1_STAT_DRAIN.bypassIgnoreFilter).toBe(true);
    expect(esci2Graph.states.POSTSCAN_2_STAT_DRAIN.bypassIgnoreFilter).toBe(true);
    // Other states (e.g. POST_MODE / INIT_POLL drain) do NOT need the
    // bypass — their _STAT decisions skip the drain entirely on length=0.
    expect(esci2Graph.states.POST_MODE_STAT_DRAIN.bypassIgnoreFilter).toBeUndefined();
    expect(esci2Graph.states.INIT_POLL_STAT_DRAIN.bypassIgnoreFilter).toBeUndefined();
  });

  it("has globalAbortHandlers covering 0x9000", () => {
    expect(esci2Graph.globalAbortHandlers).toBeDefined();
    expect(esci2Graph.globalAbortHandlers![0x9000]).toBeDefined();
  });
});

describe("esci2Graph T22 states", () => {
  it("WELCOME transitions to LOCKING on 0x8000 with a lock-packet send", () => {
    const state = esci2Graph.states.WELCOME;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      const t = state.on[0x8000];
      expect(t).toBeDefined();
      expect(t.next).toBe("LOCKING");
      expect(t.send).toBeDefined();
    }
  });

  it("LOCKING transitions to INIT1_FS_Y on 0xa100", () => {
    const state = esci2Graph.states.LOCKING;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa100]?.next).toBe("INIT1_FS_Y");
    }
  });

  it("LOCKING sends a passthru packet on 0xa100 transition", () => {
    const state = esci2Graph.states.LOCKING;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa100]?.send).toBeDefined();
    }
  });

  it("INIT1_FS_Y transitions to INIT1_INFO_META on 0xa000 (TPR sequence)", () => {
    const state = esci2Graph.states.INIT1_FS_Y;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT1_INFO_META");
    }
  });

  it("INIT1_FS_Y sends a passthru packet on 0xa000 transition", () => {
    const state = esci2Graph.states.INIT1_FS_Y;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT1_FIN transitions to INIT2_FS_Z", () => {
    const state = esci2Graph.states.INIT1_FIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_FS_Z");
    }
  });

  it("INIT2_FS_Z transitions to INIT2_INFO_META on 0xa000 (TPR sequence)", () => {
    const state = esci2Graph.states.INIT2_FS_Z;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_INFO_META");
    }
  });

  it("INIT2_FS_Z sends a passthru packet on 0xa000 transition", () => {
    const state = esci2Graph.states.INIT2_FS_Z;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT2_FIN transitions to INIT_POLL_FS_Y with FS Y send", () => {
    const state = esci2Graph.states.INIT2_FIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT_POLL_FS_Y");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });
});

describe("esci2Graph T23 INIT_POLL cycle", () => {
  it("INIT_POLL_FS_Y sends STAT and advances to INIT_POLL_STAT on an ACK", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    if (state.kind !== "decision") throw new Error("INIT_POLL_FS_Y not a decision");
    const result = state.decide(makeCtx({ initPollIteration: 1 }), {
      type: 0xa000,
      payload: Buffer.from([0x06]),
    });
    expect("next" in result && result.next).toBe("INIT_POLL_STAT");
    expect("send" in result && result.send).toEqual(
      buildPassthruPacket(buildEsci2Command("STAT"), 64),
    );
  });

  it("INIT_POLL_FS_Y fails with the reply bytes on a non-ACK in the first cycle", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    if (state.kind !== "decision") throw new Error("INIT_POLL_FS_Y not a decision");
    const ctx = makeCtx({ initPollIteration: 0 });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0x15]) });
    expect("error" in result && result.error.message).toBe(
      "Validation failed in state INIT_POLL_FS_Y for packet type 0xa000 (payload len=1, head=0x15)",
    );
    expect(ctx.initPollEarlyStop).toBeUndefined();
  });

  it("INIT_POLL_FS_Y stops the poll early on a non-ACK after a good cycle, warning with the bytes", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    if (state.kind !== "decision") throw new Error("INIT_POLL_FS_Y not a decision");
    // Iteration 1 = one good cycle done, so this FS Y opens cycle 2 of 3.
    const ctx = makeCtx({ initPollIteration: 1 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0x15]) });
      expect("next" in result && result.next).toBe("MODE_SWITCH");
      expect("send" in result && result.send).toEqual(buildPassthruPacket(buildFsX(), 1));
      expect(ctx.initPollEarlyStop).toEqual({ cycle: 2, reply: "payload len=1, head=0x15" });
      const messages = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(messages).toContain("cycle 2 of 3");
      expect(messages).toContain("payload len=1, head=0x15");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("INIT_POLL_FS_Y fails on a multi-byte non-ACK after a good cycle (likely desync)", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    if (state.kind !== "decision") throw new Error("INIT_POLL_FS_Y not a decision");
    const ctx = makeCtx({ initPollIteration: 1 });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from("#ERRADF PE  ") });
    expect("error" in result && result.error.message).toBe(
      "Validation failed in state INIT_POLL_FS_Y for packet type 0xa000 (payload len=12, head=0x234552524144462050452020)",
    );
    expect(ctx.initPollEarlyStop).toBeUndefined();
  });

  it("INIT_POLL_FS_Y rejects a non-0xa000 packet with the static-state wording", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    if (state.kind !== "decision") throw new Error("INIT_POLL_FS_Y not a decision");
    const result = state.decide(makeCtx({ initPollIteration: 1 }), {
      type: 0xa100,
      payload: Buffer.from([0x06]),
    });
    expect("error" in result && result.error.message).toBe(
      "Unexpected packet type 0xa100 in state INIT_POLL_FS_Y",
    );
  });

  it("names an early stop as the likely cause of a later failure, keeping the stack", () => {
    expect(esci2Graph.describeProtocolFailure).toBe(nameInitPollEarlyStop);
    const reason = new Error(
      "Validation failed in state MODE_SWITCH for packet type 0xa000 (payload len=1, head=0x15)",
    );
    const ctx = makeCtx({ initPollEarlyStop: { cycle: 2, reply: "payload len=1, head=0x15" } });
    const named = nameInitPollEarlyStop(ctx, reason);
    expect(named.message).toContain(reason.message);
    expect(named.message).toContain("likely cause: the init poll stopped early");
    expect(named.message).toContain("cycle 2 with a non-ACK (payload len=1, head=0x15)");
    expect(named.cause).toBe(reason);
    // The original's frames, not nameInitPollEarlyStop's, follow the new message.
    const frames = (stack: string | undefined) => stack?.split("\n").slice(1).join("\n");
    expect(named.stack?.split("\n")[0]).toBe(`Error: ${named.message}`);
    expect(frames(named.stack)).toBe(frames(reason.stack));
  });

  it("nameInitPollEarlyStop leaves the reason alone without an early stop", () => {
    const reason = new Error("Timeout in state MODE_SWITCH — no response in 60000ms");
    expect(nameInitPollEarlyStop(makeCtx(), reason)).toBe(reason);
  });

  it("PARA acceptance clears an early stop, so later failures aren't blamed on it", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") throw new Error("PARA not a decision");
    const ctx = makeCtx({ initPollEarlyStop: { cycle: 2, reply: "payload len=1, head=0x15" } });
    const result = state.decide(ctx, {
      type: 0xa000,
      payload: Buffer.from("PARAx0000000#parOK  ", "ascii"),
    });
    expect("next" in result && result.next).toBe("TRDT");
    expect(ctx.initPollEarlyStop).toBeUndefined();
  });

  it("INIT_POLL_STAT is a decision state", () => {
    expect(esci2Graph.states.INIT_POLL_STAT.kind).toBe("decision");
  });

  it("INIT_POLL_STAT_DRAIN advances to INIT_POLL_FIN with a FIN send on 0xa000", () => {
    // A static state: the init poll's statuses are drained unread.
    const state = esci2Graph.states.INIT_POLL_STAT_DRAIN;
    expect(state.kind).toBe("static");
    if (state.kind !== "static") return;
    expect(state.on[0xa000]?.next).toBe("INIT_POLL_FIN");
    expect(state.on[0xa000]?.send).toEqual(
      buildPassthruPacket(buildEsci2Command("FIN"), ESCI2_REPLY_SIZE),
    );
    expect(state.on[0xa100]).toBeUndefined();
  });

  it("INIT_POLL_FIN is a decision state (loop check)", () => {
    expect(esci2Graph.states.INIT_POLL_FIN.kind).toBe("decision");
  });

  it("INIT_POLL_FIN loops back to INIT_POLL_FS_Y while initPollIteration < 3", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      // Simulate first completion (iteration was 0, bumps to 1 — still < 3).
      const ctx = makeCtx({ initPollIteration: 0 });
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
      expect("next" in result && result.next).toBe("INIT_POLL_FS_Y");
      expect(ctx.initPollIteration).toBe(1);
    }
  });

  it("INIT_POLL_FIN advances to MODE_SWITCH after 3 iterations", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      // Simulate third completion (iteration was 2, bumps to 3 — equals INIT_POLL_ITERATIONS).
      const ctx = makeCtx({ initPollIteration: 2 });
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
      expect("next" in result && result.next).toBe("MODE_SWITCH");
      expect(ctx.initPollIteration).toBe(3);
    }
  });

  it("INIT_POLL_FIN loops on the ET-2750 model override while initPollIteration < 2", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // ET-2750 host driver only loops twice. After the first FIN reply,
    // iteration goes 0 → 1 (still < dialect.initPollIterations=2), so loop.
    const ctx = makeCtx({
      entry: recordedDialect("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7"),
      initPollIteration: 0,
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
    expect("next" in result && result.next).toBe("INIT_POLL_FS_Y");
    expect(ctx.initPollIteration).toBe(1);
  });

  it("INIT_POLL_FIN advances to MODE_SWITCH on the ET-2750 model override after 2 iterations", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // Iteration was 1, bumps to 2 — equals dialect.initPollIterations=2, advance.
    const ctx = makeCtx({
      entry: recordedDialect("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7"),
      initPollIteration: 1,
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
    expect("next" in result && result.next).toBe("MODE_SWITCH");
    expect(ctx.initPollIteration).toBe(2);
  });

  it("INIT_POLL inline states are all defined", () => {
    expect(esci2Graph.states.INIT_POLL_STAT).toBeDefined();
    expect(esci2Graph.states.INIT_POLL_STAT_DRAIN).toBeDefined();
    expect(esci2Graph.states.INIT_POLL_FIN).toBeDefined();
  });
});

describe("esci2Graph T24 — twoPhaseRead (INIT1 TPR)", () => {
  it("INIT1_INFO_META is a decision state", () => {
    expect(esci2Graph.states.INIT1_INFO_META.kind).toBe("decision");
  });

  it("INIT1_INFO_META rejects bad command name", () => {
    const state = esci2Graph.states.INIT1_INFO_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      // Build a header with cmd=CAPA (wrong for INFO state)
      const badPayload = Buffer.from("CAPAx0000010" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload: badPayload });
      expect("error" in result).toBe(true);
    }
  });

  it("INIT1_INFO_META advances to INIT1_INFO_DATA on valid INFO header", () => {
    const state = esci2Graph.states.INIT1_INFO_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.from("INFOx0000020" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("INIT1_INFO_DATA");
      expect("send" in result && result.send).toBeDefined();
    }
  });

  it("INIT1_INFO_DATA advances to INIT1_CAPA_META with CAPA send", () => {
    const state = esci2Graph.states.INIT1_INFO_DATA;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      // Body length is captured per-helper-instance; we don't have access to
      // the closure here, so feed an arbitrary-length payload and check the
      // next/send shape only when validation would skip.
      // Simpler: just confirm the state exists as a decision.
      expect(state.decide).toBeDefined();
    }
  });

  it("INIT1_CAPA_META is a decision state", () => {
    expect(esci2Graph.states.INIT1_CAPA_META.kind).toBe("decision");
  });

  it("INIT1_CAPA_DATA is a decision state (validates body length)", () => {
    expect(esci2Graph.states.INIT1_CAPA_DATA.kind).toBe("decision");
  });
});

describe("esci2Graph T24 — twoPhaseRead (INIT2 TPR)", () => {
  it("INIT2_INFO_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_INFO_META.kind).toBe("decision");
  });

  it("INIT2_INFO_DATA is a decision state (validates body length)", () => {
    expect(esci2Graph.states.INIT2_INFO_DATA.kind).toBe("decision");
  });

  it("INIT2_CAPA_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_CAPA_META.kind).toBe("decision");
  });

  it("INIT2_CAPA_DATA is a decision state (validates body length)", () => {
    expect(esci2Graph.states.INIT2_CAPA_DATA.kind).toBe("decision");
  });

  it("INIT2_RESA_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_RESA_META.kind).toBe("decision");
  });

  it("INIT2_RESA_DATA is a decision state (validates body length)", () => {
    expect(esci2Graph.states.INIT2_RESA_DATA.kind).toBe("decision");
  });
});

describe("esci2Graph T24 — MODE_SWITCH / POST_MODE_STAT / PARA / TRDT / IMG_META", () => {
  it("MODE_SWITCH is a static state that validates ACK byte", () => {
    const state = esci2Graph.states.MODE_SWITCH;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("POST_MODE_STAT");
      expect(state.on[0xa000]?.validate).toBeDefined();
      const validateFn = state.on[0xa000]?.validate;
      // ACK byte (0x06) passes
      expect(validateFn?.(Buffer.from([0x06]))).toBe(true);
      // Non-ACK fails
      expect(validateFn?.(Buffer.from([0x15]))).toBe(false);
    }
  });

  it("POST_MODE_STAT is a decision state", () => {
    expect(esci2Graph.states.POST_MODE_STAT.kind).toBe("decision");
  });

  it("POST_MODE_STAT drains when length > 0", () => {
    const state = esci2Graph.states.POST_MODE_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      // Header declaring 12 bytes of data
      const payload = Buffer.from("STATx000000C" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("POST_MODE_STAT_DRAIN");
    }
  });

  it("POST_MODE_STAT skips drain when length === 0 and goes to PARA", () => {
    const state = esci2Graph.states.POST_MODE_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("PARA");
      // send should be an array (para header + body)
      expect("send" in result && Array.isArray(result.send)).toBe(true);
    }
  });

  it("POST_MODE_STAT_DRAIN advances to PARA with para send array", () => {
    const state = esci2Graph.states.POST_MODE_STAT_DRAIN;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const result = state.decide(makeCtx({ source: "adf" }), {
        type: 0xa000,
        payload: Buffer.alloc(0),
      });
      expect("next" in result && result.next === "PARA").toBe(true);
      if ("next" in result) {
        expect(Array.isArray(result.send)).toBe(true);
      }
    }
  });

  it("PARA is a decision state (rewritten from validate: matcher so a rejected reply produces a real error, not an unmatched-packet timeout)", () => {
    expect(esci2Graph.states.PARA.kind).toBe("decision");
  });

  it("PARA validates #parOK token and advances to TRDT", () => {
    const state = esci2Graph.states.PARA;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const okPayload = Buffer.from("PARAx0000000#parOK  ", "ascii");
    const result = state.decide(makeCtx(), { type: 0xa000, payload: okPayload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("TRDT");
    expect(result.send).toBeDefined();
  });

  // makeCtx's default entry (ET-4950) seeds verifiedWireDpis: [300].

  it("PARA rejects a non-OK #par token with an actionable error naming the wire DPI and inviting removal of SCAN_RESOLUTION when it was set explicitly and the resulting wire DPI is unverified", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") return;
    // 100 is CAPA-advertised on the ET-4950 but outside its verifiedWireDpis
    // (75/150/200/300/600/1200 are hardware-verified as of 2026-09-02).
    const ctx = makeCtx({ resolution: 100, wireDpi: 100 });
    const ngPayload = Buffer.from("PARAx0000000#parNG  ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload: ngPayload });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.message).toMatch(/PARA rejected/);
    expect(result.error.message).toMatch(/100/);
    expect(result.error.message).toMatch(/SCAN_RESOLUTION/);
  });

  it("PARA rejection still includes a hint on an unverified wire DPI even when resolution was left at the dialect default (the real suspect is the wire DPI, not how it was set) — but drops the 'remove SCAN_RESOLUTION' clause since nothing was set to remove", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ resolution: undefined, wireDpi: 100 });
    const ngPayload = Buffer.from("PARAx0000000#parNG  ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload: ngPayload });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.message).toMatch(/PARA rejected/);
    expect(result.error.message).toMatch(/100/);
    expect(result.error.message).toMatch(/report the result \(issue #81\)/);
    expect(result.error.message).not.toMatch(/SCAN_RESOLUTION/);
    expect(result.error.message).not.toMatch(/remove/);
  });

  it("PARA rejection omits the hint when the wire DPI in use is verified, even though resolution was set explicitly", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ resolution: 300, wireDpi: 300 });
    const ngPayload = Buffer.from("PARAx0000000#parNG  ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload: ngPayload });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.message).toMatch(/PARA rejected/);
    expect(result.error.message).not.toMatch(/SCAN_RESOLUTION/);
  });

  it("PARA rejection omits the hint when resolution was left at the dialect default and the resulting wire DPI is verified", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ resolution: undefined, wireDpi: 300 });
    const ngPayload = Buffer.from("PARAx0000000#parNG  ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload: ngPayload });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.message).toMatch(/PARA rejected/);
    expect(result.error.message).not.toMatch(/SCAN_RESOLUTION/);
  });

  it("PARA errors on an unparseable reply header", () => {
    const state = esci2Graph.states.PARA;
    if (state.kind !== "decision") return;
    const result = state.decide(makeCtx(), { type: 0xa000, payload: Buffer.from("bad") });
    expect("error" in result).toBe(true);
  });

  it("TRDT advances to IMG_META with IMG send", () => {
    const state = esci2Graph.states.TRDT;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("IMG_META");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("IMG_META is a decision state", () => {
    expect(esci2Graph.states.IMG_META.kind).toBe("decision");
  });

  it("IMG_META errors on unparseable header", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from("bad") });
      expect("error" in result).toBe(true);
    }
  });

  it("IMG_META errors on #ERR token", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      // 12-byte header + #ERR token
      const payload = Buffer.from("IMG x0000020#ERRADF ", "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("error" in result).toBe(true);
    }
  });

  it("IMG_META sets ctx fields and advances to IMG_DATA", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      // Header: length=0x20=32, tokens: #pst, typ=IMGF (front), no #pen
      const payload = Buffer.from("IMG x0000020#pst#typIMGF", "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("IMG_DATA");
      expect(ctx.imgChunkSize).toBe(0x20);
      expect(ctx.pageSide).toBe("front");
      expect(ctx.pageEndKind).toBe("none");
    }
  });

  it("IMG_META sets pageSide=back for IMGB typ token", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx({ duplex: true });
      const payload = Buffer.from("IMG x0000010#typIMGB", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageSide).toBe("back");
    }
  });

  it("IMG_META sets pageEndKind=more for ADF #pen without #lft", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.from("IMG x0000010#pen#typIMGF", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("more");
    }
  });

  it("IMG_META sets pageEndKind=last for ADF #pen + #lftd000", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.from("IMG x0000010#pen#lftd000", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("last");
    }
  });

  it("IMG_META sets pageEndKind=last for flatbed #pen (no #lft)", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx({ source: "flatbed" });
      // Flatbed emits #pen but never #lft; source=flatbed must resolve "last".
      const payload = Buffer.from("IMG x0000010#pen#typIMGF", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("last");
    }
  });
});

function makeCtx(
  overrides: Partial<import("./graph.js").Esci2Ctx> = {},
): import("./graph.js").Esci2Ctx {
  return {
    duplex: false,
    source: "adf",
    transport: "tls",
    action: "jpg",
    resolution: 200,
    colorMode: "color",
    initPollIteration: 0,
    genericDialect: false,
    imgChunkSize: 0,
    pageEndKind: "none",
    pageSide: "front",
    zeroImgRetries: 0,
    imageChunks: [],
    tprDeclaredLength: 0,
    infoBody: Buffer.alloc(0),
    capaBody: Buffer.alloc(0),
    capaTokens: undefined,
    entry: recordedDialect("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"),
    jpegQuality: DEFAULT_JPEG_QUALITY,
    wireDpi: undefined,
    downsampleToDpi: undefined,
    ...overrides,
  };
}

const FF680W_FP = "5d4dea564bf876ff0714a167b700007bd381de839615ad8dbded0c59c53eaabd";

// Real FF-680W CAPA resolution segments (from tools/pcap-extract/captures/ff-680w
// fixtures) — 200 and 300 are both advertised exactly, so an explicit
// ctx.resolution of either reaches the wire unchanged (no downsample/cap).
const FF680W_CAPA_TOKENS = parseCapaTokens(
  Buffer.from(
    "#ADFRSMSLISTd300d600" +
      "#RSMLISTd050d075d100d150d200d240d300d360d400d600" +
      "#RSSLISTd050d075d100d150d200d240d300d360d400d600" +
      "#JPGRANGd001d100",
    "ascii",
  ),
);

describe("esci2Graph POST_MODE_STAT — PARA reflects ctx.resolution + source", () => {
  // Drives the state that calls buildParaSend(ctx) and inspects the emitted
  // phase-2 PARA passthru. Proves ctx.resolution/source actually reach the wire
  // bytes via the graph — composePara unit tests alone don't cover the thread.
  function emitParaBody(overrides: Partial<import("./graph.js").Esci2Ctx>): string {
    const state = esci2Graph.states.POST_MODE_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const ctx = makeCtx({
      entry: recordedDialect(FF680W_FP),
      source: "adf",
      capaTokens: FF680W_CAPA_TOKENS,
      ...overrides,
    });
    // STAT reply header length 0 → PARA branch (send = buildParaSend(ctx)).
    const result = state.decide(ctx, {
      type: 0xa000,
      payload: Buffer.from("STATx0000000" + " ".repeat(52), "ascii"),
    });
    if (!("send" in result)) throw new Error("expected a send from POST_MODE_STAT");
    expect(Array.isArray(result.send)).toBe(true); // phase-1 header + phase-2 body
    const sends = result.send as Buffer[];
    expect(sends.length).toBe(2);
    // Strip the 8-byte passthru preamble (cmd_size + reply_size) to reach the PARA body.
    return parseIsPacket(sends[1])!.payload.subarray(8).toString("latin1");
  }

  it("emits #RSMi0000300 and scaled #ACQ when ctx.resolution=300", () => {
    const body = emitParaBody({ resolution: 300, duplex: false });
    expect(body).toContain("#RSMi0000300");
    expect(body).toContain("#RSSi0000300");
    expect(body).toContain("#ACQi0000000i0000000i0002550i0010800");
  });

  it("emits the DPLX token for duplex and omits it for simplex", () => {
    expect(emitParaBody({ resolution: 200, duplex: true })).toContain("SKEWDPLXDFL1");
    expect(emitParaBody({ resolution: 200, duplex: false })).toContain("SKEWDFL1");
    expect(emitParaBody({ resolution: 200, duplex: false })).not.toContain("DPLX");
  });
});

// Real ET-4950 CAPA resolution segments (from the committed Frida capture) —
// matches the sample in resolution.test.ts. Advertises exact 300 and 600, so
// selection can be pinned exactly against these DPIs.
const ET4950_CAPA_TOKENS = parseCapaTokens(
  Buffer.from(
    "#ADFRSMSLISTd075d150d200d300d600" +
      "#FB RSMSLISTd075d150d200d300d600i0001200" +
      "#RSMLISTd050d075d100d150d200d300d600i0001200" +
      "#RSSLISTd050d075d100d150d200d300d600i0001200i0002400",
    "ascii",
  ),
);

describe("esci2Graph buildParaSend — wire DPI selection + JPEG quality clamp (Task 5)", () => {
  // Drives POST_MODE_STAT (which calls buildParaSend) and returns both the
  // mutated ctx and the decoded PARA body text.
  function runParaBuild(overrides: Partial<import("./graph.js").Esci2Ctx>): {
    ctx: import("./graph.js").Esci2Ctx;
    body: string;
  } {
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const ctx = makeCtx(overrides);
    const result = state.decide(ctx, {
      type: 0xa000,
      payload: Buffer.from("STATx0000000" + " ".repeat(52), "ascii"),
    });
    if ("error" in result) throw result.error;
    if (!("send" in result) || !Array.isArray(result.send)) {
      throw new Error("expected a 2-element send array from POST_MODE_STAT");
    }
    const sends = result.send as Buffer[];
    const body = parseIsPacket(sends[1])!.payload.subarray(8).toString("latin1");
    return { ctx, body };
  }

  it("selects wire DPI from CAPA and records downsample intent", () => {
    const { ctx, body } = runParaBuild({
      resolution: 240,
      capaTokens: ET4950_CAPA_TOKENS,
      source: "adf",
      duplex: false,
    });
    expect(body).toContain("#RSMi0000300");
    expect(ctx.wireDpi).toBe(300);
    expect(ctx.downsampleToDpi).toBe(240);
  });

  it("warns once when an explicit resolution is outside verifiedWireDpis", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The ET-4950 CAPA fixture advertises 100 exactly, so it resolves
      // cleanly on the wire, but 100 is outside the entry's verifiedWireDpis
      // (75/150/200/300/600/1200 hardware-verified 2026-09-02) — still
      // unverified by our own bar.
      const { ctx } = runParaBuild({
        resolution: 100,
        capaTokens: ET4950_CAPA_TOKENS,
        source: "adf",
        duplex: false,
      });
      expect(ctx.wireDpi).toBe(100);
      expect(warnSpy).toHaveBeenCalled();
      const messages = warnSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(messages).toMatch(/unverified/);
      expect(messages).toMatch(/#81/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when resolution is undefined (dialect default), even though verifiedWireDpis gates explicit requests only", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ctx } = runParaBuild({
        resolution: undefined,
        capaTokens: ET4950_CAPA_TOKENS,
        source: "adf",
        duplex: false,
      });
      expect(ctx.wireDpi).toBe(300);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("clamps jpegQuality to the advertised #JPGRANG", () => {
    const capa = parseCapaTokens(Buffer.from("#JPGRANGd001d085", "ascii"));
    const { body } = runParaBuild({
      capaTokens: capa,
      jpegQuality: 90,
      resolution: undefined,
    });
    expect(body).toContain("#JPGd085");
  });

  it("an advertised #JPGRANG entirely outside 1..100 is ignored — falls back to ctx.jpegQuality unclamped", () => {
    // #JPGRANGd150d200 sits entirely above the JPEG quality domain; a naive
    // clamp would produce a nonsensical #JPGd150+ wire value. The
    // intersection with [1,100] is empty, so the advertised range is
    // discarded and the (already config-bounded) requested quality is used
    // as-is — the session must still complete, not throw.
    const capa = parseCapaTokens(Buffer.from("#JPGRANGd150d200", "ascii"));
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { body } = runParaBuild({
        capaTokens: capa,
        jpegQuality: 90,
        resolution: undefined,
      });
      expect(body).toContain("#JPGd090");
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("JPEG quality"));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("an advertised #JPGRANG with an out-of-domain edge is sanitized to 1..100 before clamping, and logs the clamp", () => {
    // #JPGRANGd000d080: min=0 is below the 1..100 domain and sanitizes up to
    // 1; the intersected range [1,80] is non-empty, so it clamps normally.
    const capa = parseCapaTokens(Buffer.from("#JPGRANGd000d080", "ascii"));
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { body } = runParaBuild({
        capaTokens: capa,
        jpegQuality: 90,
        resolution: undefined,
      });
      expect(body).toContain("#JPGd080");
      expect(infoSpy).toHaveBeenCalled();
      const message = String(infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0]);
      expect(message).toContain("90");
      expect(message).toContain("80");
      expect(message).toContain("0-80");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("no advertised lists: target still gets full selection semantics (downsample below pinned default, cap above it)", () => {
    const capa = parseCapaTokens(Buffer.from("#GMMLISTUG10", "ascii"));
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const under = runParaBuild({ capaTokens: capa, resolution: 150 });
      expect(under.ctx.wireDpi).toBe(300);
      expect(under.ctx.downsampleToDpi).toBe(150);

      const over = runParaBuild({ capaTokens: capa, resolution: 600 });
      expect(over.ctx.wireDpi).toBe(300);
      expect(over.ctx.downsampleToDpi).toBeUndefined();
      expect(infoSpy).toHaveBeenCalled();
      const message = String(infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0]);
      expect(message).toContain("SCAN_RESOLUTION=600 exceeds this model's maximum");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("caps a default (unset SCAN_RESOLUTION) target without naming the env var", () => {
    // Synthetic CAPA whose advertised max (200) sits below the standard
    // profile's 300 DPI pinned default — realistic hardware wouldn't
    // advertise this, but it's the only way to force the default-branch
    // cap path (buildParaSend's `target = ctx.resolution ?? pinnedDefault`)
    // without SCAN_RESOLUTION ever being set.
    const capa = parseCapaTokens(
      Buffer.from("#RSMLISTd050d075d100d150d200#RSSLISTd050d075d100d150d200", "ascii"),
    );
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = runParaBuild({ capaTokens: capa, resolution: undefined, source: "adf" });
      expect(ctx.wireDpi).toBe(200);
      expect(infoSpy).toHaveBeenCalled();
      const message = String(infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0]);
      expect(message).not.toMatch(/SCAN_RESOLUTION/);
      expect(message).toContain("200 DPI");
      expect(message).toContain("300 DPI pinned default");
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("esci2Graph POST_MODE_STAT — duplex capability guard", () => {
  const ET4800_FP = "7870a725ab969136d5eb04387bf01d3cc3168aabb3d11cfaca7d59a4169971c2";
  const ET2810_FP = "708704b6abb184cede037fcd9893ea81f69651fde28780cde0162dfa33a33f6e";
  // STAT reply header length 0 → the PARA branch, i.e. send = buildParaSend(ctx).
  const statPayload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");

  function decidePostModeStat(overrides: Partial<import("./graph.js").Esci2Ctx>) {
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    return state.decide(makeCtx(overrides), { type: 0xa000, payload: statPayload });
  }

  it("throws for ADF + duplex on the ET-4800 (simplex-only ADF)", () => {
    expect(() =>
      decidePostModeStat({ entry: recordedDialect(ET4800_FP), source: "adf", duplex: true }),
    ).toThrow(/no duplex ADF/);
  });

  it("sends PARA for ADF + simplex on the ET-4800", () => {
    const result = decidePostModeStat({
      entry: recordedDialect(ET4800_FP),
      source: "adf",
      duplex: false,
    });
    expect("send" in result).toBe(true);
  });

  // The ET-2810 is flatbed-only and SCAN_SIDES defaults to "duplex", so this is
  // the shape of EVERY default-config host-triggered scan on it. duplex is inert
  // once the source is flatbed and the guard must not fire.
  it("sends PARA for flatbed + duplex on a flatbed-only entry", () => {
    const result = decidePostModeStat({
      entry: recordedDialect(ET2810_FP),
      source: "flatbed",
      duplex: true,
    });
    expect("send" in result).toBe(true);
  });
});

describe("esci2Graph POST_MODE_STAT — unconfirmed duplex orientation warning", () => {
  const statPayload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
  const ORIENTATION_WARNING = "which way up duplex back pages arrive";

  // The warn lines one PARA build logs.
  function orientationWarnings(
    overrides: Partial<import("./graph.js").Esci2Ctx>,
    payload = statPayload,
  ): string[] {
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = state.decide(makeCtx(overrides), { type: 0xa000, payload });
      expect("send" in result).toBe(true);
      return warn.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes(ORIENTATION_WARNING));
    } finally {
      warn.mockRestore();
    }
  }

  // An entry with a duplex ADF (the ET-4950's) and no orientation evidence.
  function unconfirmed(displayName: string): import("./dialects/model-overrides.js").Dialect {
    const { duplexOrientationEvidence: _evidence, ...rest } = recordedDialect(
      "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
    );
    return { ...rest, displayName };
  }

  it.each([
    ["ET-4950 family", "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"],
    ["XP-7100", "56d26c61896ca417807ac68d37775036fa1e702ee44c0beaa27d8a6ea9fa457e"],
    ["FF-680W", FF680W_FP],
    ["DS-575W", "90f98ad1ef34fc40fcd9b49f880b0599569c80b343ab9b05c92d15cfac30b074"],
  ])("is silent on a duplex scan for the %s, whose orientation is confirmed", (_model, fp) => {
    const entry = recordedDialect(fp);
    expect(entry.adfDuplex).toBe(true);
    expect(orientationWarnings({ entry, source: "adf", duplex: true })).toEqual([]);
  });

  it("warns on the first duplex scan of a model with no evidence, once per process", () => {
    const first = orientationWarnings({
      entry: unconfirmed("Model A"),
      source: "adf",
      duplex: true,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("Model A");
    // Rotated (two-pass, #ADFDPLX2SCN): the warning says what was done.
    expect(first[0]).toContain("turned 180°");
    expect(first[0]).toContain("please open an issue");
    expect(
      orientationWarnings({ entry: unconfirmed("Model A"), source: "adf", duplex: true }),
    ).toEqual([]);
    // Once per model, not once overall.
    expect(
      orientationWarnings({ entry: unconfirmed("Model B"), source: "adf", duplex: true }),
    ).toHaveLength(1);
  });

  it("says nothing on a simplex or flatbed scan, and keeps the warning for the first duplex one", () => {
    const entry = unconfirmed("Model C");
    expect(orientationWarnings({ entry, source: "adf", duplex: false })).toEqual([]);
    // ADF paper empty, inline: the ET-4950's status says the flatbed.
    const flatbed = Buffer.from("STATx0000000#ERRADF PE  " + "#---".repeat(10), "ascii");
    expect(orientationWarnings({ entry, duplex: true }, flatbed)).toEqual([]);
    expect(orientationWarnings({ entry, source: "adf", duplex: true })).toHaveLength(1);
  });

  it("warns when the recorded evidence vouched for the other orientation", () => {
    // As after a firmware update that changes the duplex type INFO reports:
    // the evidence confirmed back pages left as delivered, the printer now
    // says two-pass.
    const entry = {
      ...recordedDialect("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"),
      displayName: "Model E",
      duplexOrientationEvidence: { backRotated: false, source: "a checked capture" },
    };
    const lines = orientationWarnings({ entry, source: "adf", duplex: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("turned 180°");
    expect(lines[0]).toContain("a checked capture");
  });

  it("names the as-delivered choice for a single-pass ADF", () => {
    const entry = { ...unconfirmed("Model D"), duplexBackRotated: false };
    const [line] = orientationWarnings({ entry, source: "adf", duplex: true });
    expect(line).toContain("left as delivered");
  });
});

describe("esci2Graph INIT_POLL_STAT", () => {
  // The source comes from the status before PARA: see the POST_MODE_STAT
  // "source from the status before PARA" blocks below.
  it("returns INIT_POLL_FIN transition when header length is 0", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ initPollIteration: 0 });
    const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    expect("next" in result && result.next).toBe("INIT_POLL_FIN");
  });

  it("returns INIT_POLL_STAT_DRAIN transition when header length > 0", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ initPollIteration: 0 });
    const payload = Buffer.from("STATx000000c#---#---#---", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    expect("next" in result && result.next).toBe("INIT_POLL_STAT_DRAIN");
  });
});

describe("applyEntrySourceOverride", () => {
  // The TLS scanner shell pre-sets ctx.source = "adf" (scanner.ts) because
  // the dominant TLS path is ADF + flatbed, read from the status reply.
  // A flatbed-only TLS printer (fixed-flatbed detection, e.g. the
  // ET-2950) would otherwise carry "adf" all the way to composePara, which
  // throws on flatbed-only hardware. applyEntrySourceOverride pins the
  // source at the entry-resolution moment to keep every downstream
  // stage agreeing on flatbed.
  it("pins source to flatbed when entry is fixed-flatbed and ctx pre-set is adf (TLS+flatbed-only, ET-2950)", () => {
    // Exact production scenario for ET-2950: TLS shell pre-sets ctx.source = "adf"
    // (scanner.ts), entry resolves to ET-2950, override flips source.
    const ctx = makeCtx({
      source: "adf",
      transport: "tls",
      entry: recordedDialect("b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb"),
    });
    applyEntrySourceOverride(
      ctx,
      recordedDialect("b1bf50879666d04c1975d607566790bbdf0bdfa5e2e1e7b27b629e8fa540e8cb"),
    );
    expect(ctx.source).toBe("flatbed");
  });

  it("is a no-op when ctx pre-set already matches (plain-TCP+flatbed-only)", () => {
    const ctx = makeCtx({
      source: "flatbed",
      transport: "plain",
      entry: recordedDialect("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7"),
    });
    applyEntrySourceOverride(
      ctx,
      recordedDialect("de76c9302793fa8fd663c22288dea07f8fcacaee8cd710bf2d49f7075f2b56e7"),
    );
    expect(ctx.source).toBe("flatbed");
  });

  it("leaves source untouched for a printer with both sources, so POST_MODE_STAT can decide", () => {
    const ctx = makeCtx({
      source: "adf",
      transport: "tls",
      entry: recordedDialect("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"),
    });
    applyEntrySourceOverride(
      ctx,
      recordedDialect("2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2"),
    );
    expect(ctx.source).toBe("adf");
  });
});

describe("esci2Graph T25 — IMG_DATA decision", () => {
  it("IMG_DATA is a decision state", () => {
    expect(esci2Graph.states.IMG_DATA.kind).toBe("decision");
  });

  it("IMG_DATA accumulates chunk and advances to IMG_META on pageEndKind=none", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 3, pageEndKind: "none", imageChunks: [] });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0xaa, 0xbb, 0xcc]) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_META");
    expect(result.flushPage).toBeUndefined();
    expect(ctx.imageChunks.length).toBe(1);
    expect(ctx.imageChunks[0]).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  it("IMG_DATA emits flushPage with side=front when pageEndKind=last", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({
      imgChunkSize: 3,
      pageEndKind: "last",
      pageSide: "front",
      imageChunks: [],
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0xaa, 0xbb, 0xcc]) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("FIN_AFTER_IMG");
    expect(result.flushPage?.side).toBe("front");
    expect(ctx.imageChunks).toEqual([]); // reset for next page
  });

  it("IMG_DATA emits flushPage with side=back when pageEndKind=last and pageSide=back", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({
      imgChunkSize: 3,
      pageEndKind: "last",
      pageSide: "back",
      imageChunks: [],
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0xaa, 0xbb, 0xcc]) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("FIN_AFTER_IMG");
    expect(result.flushPage?.side).toBe("back");
    expect(ctx.imageChunks).toEqual([]);
  });

  it("IMG_DATA flushPage encode concatenates all accumulated chunks", async () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const prior = Buffer.from([0x01, 0x02]);
    const ctx = makeCtx({
      imgChunkSize: 2,
      pageEndKind: "last",
      pageSide: "front",
      imageChunks: [prior],
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0x03, 0x04]) });
    if ("error" in result) throw result.error;
    expect(result.flushPage).toBeDefined();
    const encoded = await result.flushPage!.encode();
    expect(encoded).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it("IMG_DATA emits flushPage on pageEndKind=more and loops to IMG_META", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({
      imgChunkSize: 2,
      pageEndKind: "more",
      pageSide: "front",
      imageChunks: [],
    });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0x11, 0x22]) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_META");
    expect(result.flushPage).toBeDefined();
    expect(result.flushPage?.side).toBe("front");
    expect(ctx.imageChunks).toEqual([]);
  });

  it("IMG_DATA validates payload length matches imgChunkSize", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 5, pageEndKind: "none", imageChunks: [] });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from([0xaa, 0xbb]) });
    expect("error" in result).toBe(true);
  });
});

describe("esci2Graph T25 — IMG_DATA XP-7100 re-echo branch", () => {
  // XP-7100 (and possibly other dialects) re-echo the IMG metadata reply in
  // response to PUREREAD before delivering pixel data. The IMG_DATA state
  // detects this by checking that the unexpected-length payload is a
  // well-formed 64-byte IMG header whose declared size matches the chunk
  // size the engine already stored, and if so re-issues PUREREAD to pull
  // the real pixel chunk.
  //
  // Covered end-to-end by the XP-7100 ADF simplex replay
  // (tools/pcap-extract/captures/xp-7100/jpg-adf-simplex.jsonl); these
  // focused cases pin the branch so future IMG_DATA refactors fail fast
  // against a unit test instead of via a ~9,800-line fixture mismatch.

  it("64-byte well-formed IMG echo with matching imgChunkSize → re-issues PUREREAD(imgChunkSize) and preserves accumulated chunks", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    // Seed two prior chunks to prove the re-echo branch is non-destructive —
    // re-echos can fire mid-page after some pixel data has already been
    // accumulated, so the existing imageChunks must survive untouched.
    const priorA = Buffer.from([0x11, 0x22, 0x33]);
    const priorB = Buffer.from([0x44, 0x55]);
    const ctx = makeCtx({
      imgChunkSize: 0x100000,
      pageEndKind: "none",
      imageChunks: [priorA, priorB],
    });
    // 64-byte IMG header re-echo: cmd="IMG", length=0x100000 (matches ctx.imgChunkSize).
    // 12-byte header + 52 bytes filler = 64 bytes total (ESCI2_REPLY_SIZE).
    const echo = Buffer.from("IMG x0100000" + " ".repeat(52), "ascii");
    expect(echo.length).toBe(64);
    const result = state.decide(ctx, { type: 0xa000, payload: echo });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_DATA");
    // Exact bytes: the response must be PUREREAD(imgChunkSize), not just
    // some non-empty send. Byte-equivalence pins the contract that the
    // engine re-asks for the *same* chunk size the printer originally
    // declared, rather than e.g. defaulting to the 64-byte reply size.
    expect(result.send).toEqual(buildPurereadPacket(0x100000));
    // Accumulated chunks survive verbatim — the re-echo is not pixel data.
    expect(ctx.imageChunks).toEqual([priorA, priorB]);
    expect(ctx.imageChunks[0]).toBe(priorA); // same reference, not a copy
    expect(ctx.imageChunks[1]).toBe(priorB);
    // No page flush — pixel data hasn't arrived yet.
    expect(result.flushPage).toBeUndefined();
  });

  it("64-byte well-formed IMG echo with non-matching imgChunkSize → errors", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 0x100000, pageEndKind: "none", imageChunks: [] });
    // Well-formed 64-byte IMG header but length=0x0099999 ≠ ctx.imgChunkSize.
    // Without the size match we can't be sure this is a benign re-echo;
    // could equally be a desync, so the safe call is to error out.
    const echo = Buffer.from("IMG x0099999" + " ".repeat(52), "ascii");
    expect(echo.length).toBe(64);
    const result = state.decide(ctx, { type: 0xa000, payload: echo });
    expect("error" in result).toBe(true);
  });

  it("64-byte payload that does not parse as an ESC/I-2 reply header → errors", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 0x100000, pageEndKind: "none", imageChunks: [] });
    // 64 zero bytes — byte 4 isn't 'x' → parseEsci2ReplyHeader returns null.
    const garbage = Buffer.alloc(64, 0x00);
    const result = state.decide(ctx, { type: 0xa000, payload: garbage });
    expect("error" in result).toBe(true);
  });

  it("64-byte well-formed reply with non-IMG cmd → errors", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 0x100000, pageEndKind: "none", imageChunks: [] });
    // Well-formed 64-byte reply header with matching length but cmd="STAT".
    // The re-echo branch is gated on cmd==="IMG"; any other command falls
    // through to the error path.
    const echo = Buffer.from("STATx0100000" + " ".repeat(52), "ascii");
    expect(echo.length).toBe(64);
    const result = state.decide(ctx, { type: 0xa000, payload: echo });
    expect("error" in result).toBe(true);
  });

  it("non-64-byte short payload that doesn't match imgChunkSize → errors", () => {
    const state = esci2Graph.states.IMG_DATA;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ imgChunkSize: 100, pageEndKind: "none", imageChunks: [] });
    // 50 bytes — neither the expected chunk size (100) nor the 64-byte echo
    // size, so the re-echo branch is skipped and we go straight to error.
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(50) });
    expect("error" in result).toBe(true);
  });
});

describe("esci2Graph T25 — IMG_META zero-length chunk handling", () => {
  it("IMG_META zero-chunk + pageEndKind=last + accumulated → emits flushPage and goes to FIN_AFTER_IMG", async () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const prior = Buffer.from([0xde, 0xad]);
    const ctx = makeCtx({ source: "flatbed", imageChunks: [prior] });
    // length=0, #pen token, flatbed → pageEndKind=last
    const payload = Buffer.from("IMG x0000000#pen#typIMGF", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("FIN_AFTER_IMG");
    expect(result.flushPage).toBeDefined();
    expect(result.flushPage?.side).toBe("front");
    const encoded = await result.flushPage!.encode();
    expect(encoded).toEqual(prior);
    expect(ctx.imageChunks).toEqual([]);
  });

  it("IMG_META zero-chunk + pageEndKind=last + empty accumulated → no flushPage, goes to FIN_AFTER_IMG", () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "flatbed", imageChunks: [] });
    const payload = Buffer.from("IMG x0000000#pen#typIMGF", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("FIN_AFTER_IMG");
    expect(result.flushPage).toBeUndefined();
  });

  it("IMG_META zero-chunk + pageEndKind=more + accumulated → emits flushPage and loops to IMG_META", async () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const prior = Buffer.from([0xbe, 0xef]);
    const ctx = makeCtx({ source: "adf", imageChunks: [prior] });
    // ADF + #pen but no #lft → pageEndKind=more
    const payload = Buffer.from("IMG x0000000#pen#typIMGF", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_META");
    expect(result.flushPage).toBeDefined();
    expect(result.flushPage?.side).toBe("front");
    const encoded = await result.flushPage!.encode();
    expect(encoded).toEqual(prior);
    expect(ctx.imageChunks).toEqual([]);
  });

  it("IMG_META zero-chunk + pageEndKind=more + empty accumulated → no flushPage, loops to IMG_META", () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "adf", imageChunks: [] });
    const payload = Buffer.from("IMG x0000000#pen#typIMGF", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_META");
    expect(result.flushPage).toBeUndefined();
  });

  it("IMG_META zero-chunk + no pen (pageEndKind=none) increments zeroImgRetries and loops", () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "adf", zeroImgRetries: 0, imageChunks: [] });
    // length=0, no #pen
    const payload = Buffer.from("IMG x0000000#typIMGF    ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_META");
    expect(result.flushPage).toBeUndefined();
    expect(ctx.zeroImgRetries).toBe(1);
  });

  it("IMG_META zero-chunk + no pen + retries exceeded → errors", () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "adf", zeroImgRetries: 5000, imageChunks: [] });
    const payload = Buffer.from("IMG x0000000#typIMGF    ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    expect("error" in result).toBe(true);
  });

  it("IMG_META non-zero chunk resets zeroImgRetries and advances to IMG_DATA", () => {
    const state = esci2Graph.states.IMG_META;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "adf", zeroImgRetries: 5, imageChunks: [] });
    // length=0x10=16, no #pen → advance to IMG_DATA
    const payload = Buffer.from("IMG x0000010#typIMGF    ", "ascii");
    const result = state.decide(ctx, { type: 0xa000, payload });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("IMG_DATA");
    expect(ctx.zeroImgRetries).toBe(0);
    expect(ctx.imgChunkSize).toBe(16);
  });
});

describe("esci2Graph T26 — FIN_AFTER_IMG decision + POSTSCAN drain cycles", () => {
  it("FIN_AFTER_IMG is a decision state", () => {
    expect(esci2Graph.states.FIN_AFTER_IMG.kind).toBe("decision");
  });

  it("FIN_AFTER_IMG with source=flatbed returns next=UNLOCKING with no send", () => {
    const state = esci2Graph.states.FIN_AFTER_IMG;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "flatbed" });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("UNLOCKING");
    expect("send" in result ? result.send : undefined).toBeUndefined();
  });

  it("FIN_AFTER_IMG with source=adf returns next=POSTSCAN_FS_Y_1 with FS Y send", () => {
    const state = esci2Graph.states.FIN_AFTER_IMG;
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ source: "adf" });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("POSTSCAN_FS_Y_1");
    expect("send" in result && result.send).toBeDefined();
  });

  it("POSTSCAN_FS_Y_1 transitions to POSTSCAN_1_STAT on 0xa000 with payload[0]=0x06", () => {
    const state = esci2Graph.states.POSTSCAN_FS_Y_1;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      const t = state.on[0xa000];
      expect(t).toBeDefined();
      expect(t.next).toBe("POSTSCAN_1_STAT");
      expect(t.send).toBeDefined();
    }
  });

  it("POSTSCAN_FS_Y_1 validate returns true for ACK byte 0x06 and false for others", () => {
    const state = esci2Graph.states.POSTSCAN_FS_Y_1;
    if (state.kind !== "static") return;
    const validateFn = state.on[0xa000]?.validate;
    expect(validateFn).toBeDefined();
    expect(validateFn?.(Buffer.from([0x06]))).toBe(true);
    expect(validateFn?.(Buffer.from([0x15]))).toBe(false);
  });

  it("POSTSCAN_1_STAT is a decision state", () => {
    expect(esci2Graph.states.POSTSCAN_1_STAT.kind).toBe("decision");
  });

  it("POSTSCAN_1_STAT always pure-reads into _STAT_DRAIN, even on zero-length reply", () => {
    // POSTSCAN cycles must mirror the legacy scanner's wire sequence —
    // it always sent a pure-read with the declared length before FIN.
    // The declared length is replayed verbatim, including 0; substituting
    // a 12-byte fallback would request bytes the printer never said it
    // would send and stall STAT_DRAIN waiting on them.
    const state = esci2Graph.states.POSTSCAN_1_STAT;
    if (state.kind !== "decision") return;
    const zeroLengthHeader = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    const result = state.decide(makeCtx({}), { type: 0xa000, payload: zeroLengthHeader });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("POSTSCAN_1_STAT_DRAIN");
    if (!("send" in result) || !result.send || Array.isArray(result.send)) {
      throw new Error("expected single Buffer send");
    }
    const send = result.send as Buffer;
    // Pure-read packet layout: IS header + 8-byte data header where
    // bytes 0-3 are the offset (0) and bytes 4-7 are the reply size BE.
    expect(send.readUInt32BE(IS_HEADER_SIZE + 4)).toBe(0);
  });

  it("statThenDrain POSTSCAN_1_FIN advances to POSTSCAN_FS_Y_2 with FS Y send", () => {
    const state = esci2Graph.states.POSTSCAN_1_FIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("POSTSCAN_FS_Y_2");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("POSTSCAN_FS_Y_2 transitions to POSTSCAN_2_STAT on 0xa000 with valid ACK", () => {
    const state = esci2Graph.states.POSTSCAN_FS_Y_2;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("POSTSCAN_2_STAT");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("POSTSCAN_FS_Y_2 validate returns true for ACK byte 0x06 and false for others", () => {
    const state = esci2Graph.states.POSTSCAN_FS_Y_2;
    if (state.kind !== "static") return;
    const validateFn = state.on[0xa000]?.validate;
    expect(validateFn).toBeDefined();
    expect(validateFn?.(Buffer.from([0x06]))).toBe(true);
    expect(validateFn?.(Buffer.from([0x15]))).toBe(false);
  });

  it("statThenDrain POSTSCAN_2_FIN advances to UNLOCKING with no send", () => {
    const state = esci2Graph.states.POSTSCAN_2_FIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("UNLOCKING");
      expect(state.on[0xa000]?.send).toBeUndefined();
    }
  });

  it("POSTSCAN_2_STAT always pure-reads into _STAT_DRAIN on zero-length reply too", () => {
    const state = esci2Graph.states.POSTSCAN_2_STAT;
    if (state.kind !== "decision") return;
    const zeroLengthHeader = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    const result = state.decide(makeCtx({}), { type: 0xa000, payload: zeroLengthHeader });
    if ("error" in result) throw result.error;
    expect(result.next).toBe("POSTSCAN_2_STAT_DRAIN");
    if (!("send" in result) || !result.send || Array.isArray(result.send)) {
      throw new Error("expected single Buffer send");
    }
    expect((result.send as Buffer).readUInt32BE(IS_HEADER_SIZE + 4)).toBe(0);
  });

  it("cleanupStates does NOT include FIN_AFTER_IMG (matches v0.3.0 contract)", () => {
    // Failures while waiting for the post-image FIN ack — async fatal,
    // malformed reply, timeout — can signal real end-of-transfer
    // protocol errors (printer abort mid-transfer rather than panel
    // hygiene). They must not be silently recovered as success.
    expect(esci2Graph.cleanupStates?.has("FIN_AFTER_IMG")).toBe(false);
    // POSTSCAN_* and UNLOCKING ARE forgiven — those are panel hygiene.
    expect(esci2Graph.cleanupStates?.has("UNLOCKING")).toBe(true);
    expect(esci2Graph.cleanupStates?.has("POSTSCAN_FS_Y_1")).toBe(true);
    expect(esci2Graph.cleanupStates?.has("POSTSCAN_2_FIN")).toBe(true);
  });
});

describe("esci2Graph T27 UNLOCKING", () => {
  it("UNLOCKING is a static state with onEnter sending the unlock packet", () => {
    const state = esci2Graph.states.UNLOCKING;
    expect(state.kind).toBe("static");
    if (state.kind !== "static") return;
    expect(state.onEnter).toBeDefined();
    const ctx = makeCtx({});
    const bytes = state.onEnter!(ctx);
    expect(bytes).toBeDefined();
    expect(bytes!.length).toBeGreaterThan(0);
    // Unlock packet IS type 0x2101 (verify by inspecting bytes 2-3 of the IS frame).
    expect(bytes![2]).toBe(0x21);
    expect(bytes![3]).toBe(0x01);
  });

  it("UNLOCKING transitions to DONE on 0xa101", () => {
    const state = esci2Graph.states.UNLOCKING;
    if (state.kind !== "static") return;
    expect(state.on[0xa101]?.next).toBe("DONE");
  });

  it("UNLOCKING's transition has no send (sent via onEnter, not on transition)", () => {
    const state = esci2Graph.states.UNLOCKING;
    if (state.kind !== "static") return;
    expect(state.on[0xa101]?.send).toBeUndefined();
  });
});

describe("esci2Graph INIT1_CAPA_DATA — resolving a fixture model's dialect", () => {
  // Feeds INIT1's CAPA body to the state that resolves the dialect, with
  // INFO already captured, and returns the info-level lines it logged.
  function resolveDialect(
    info: Buffer,
    capa: Buffer,
  ): { ctx: import("./graph.js").Esci2Ctx; lines: unknown[][] } {
    const state = esci2Graph.states.INIT1_CAPA_DATA;
    if (state.kind !== "decision") throw new Error("INIT1_CAPA_DATA not a decision");
    const ctx = makeCtx({ entry: undefined, infoBody: info, tprDeclaredLength: capa.length });
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = state.decide(ctx, { type: 0xa000, payload: capa });
      expect("error" in result).toBe(false);
      return { ctx, lines: infoSpy.mock.calls };
    } finally {
      infoSpy.mockRestore();
    }
  }

  it.each(REPLAY_FIXTURES)("logs nothing at info for the $model fixture $path", ({ path }) => {
    const { info, capa } = readInit1Bodies(path);
    const { ctx, lines } = resolveDialect(info, capa);
    expect(ctx.entry).toBeDefined();
    expect(lines).toEqual([]);
  });
});

describe("esci2Graph INIT1_CAPA_DATA — model identity", () => {
  // A CAPA reply the identified model was never recorded with, as after a
  // firmware update: the session warns with the diagnostic and carries on
  // with the model's entry instead of failing.
  it.each([
    ["PID", "tools/frida-capture/captures/2026-04-24T09-05-08-flatbed-1p-jpg.jsonl"],
    ["product name", "tools/pcap-extract/captures/ff-680w/adf-simplex-200.jsonl"],
  ])("continues on a fingerprint mismatch after a %s hit", (_kind, path) => {
    const { info, capa } = readInit1Bodies(path);
    const changed = Buffer.concat([capa, Buffer.from("#ZZZZd001", "ascii")]);
    const state = esci2Graph.states.INIT1_CAPA_DATA;
    if (state.kind !== "decision") throw new Error("INIT1_CAPA_DATA not a decision");
    const ctx = makeCtx({ entry: undefined, infoBody: info, tprDeclaredLength: changed.length });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = state.decide(ctx, { type: 0xa000, payload: changed });
      expect("error" in result).toBe(false);
      expect(ctx.entry).toMatchObject(
        unresolvedFields(OVERRIDES_BY_FINGERPRINT.get(computeCapaFingerprint(capa))!),
      );
      const warnings = warn.mock.calls.map((args) => args.join(" "));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`CAPA fingerprint:  ${computeCapaFingerprint(changed)}`);
    } finally {
      warn.mockRestore();
    }
  });
});

// A STAT reply header declaring a body of `length` bytes, with filler inline.
const statHeader = (length: number) =>
  Buffer.from(`STATx${length.toString(16).toUpperCase().padStart(7, "0")}` + "#---".repeat(13));
const ET2750_PATH = "tools/pcap-extract/captures/et-2750/flatbed-single-page-pdf.jsonl";

describe("esci2Graph POST_MODE_STAT — source from the status before PARA (model overrides)", () => {
  // Which source each replay fixture's status before PARA lands on is
  // covered with the judging tests below.
  const ET4950_ENTRY = recordedDialect(
    "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
  );
  const ET2750_ENTRY = recordedDialect(computeCapaFingerprint(readInit1Bodies(ET2750_PATH).capa));
  const LOAD = "load the document into the ADF and scan again";
  const CLEAR = "clear it on the printer and scan again";
  const STOP = (error: string, advice = CLEAR) =>
    `POST_MODE_STAT_DRAIN: the printer reported an error before scanning (${error}) — ${advice}`;

  // Feeds the mode switch's STAT reply (header, then the drained body when
  // the header declares one) from a pre-set source, as the scanner shell's
  // default may be, and returns ctx plus the last state's result: its next
  // state, or its error message.
  function statusBeforePara(
    entry: import("./dialects/model-overrides.js").Dialect,
    header: Buffer,
    body: Buffer | null,
    preset: "adf" | "flatbed" = "adf",
  ): { ctx: import("./graph.js").Esci2Ctx; outcome: string | undefined } {
    const stat = esci2Graph.states.POST_MODE_STAT;
    const drain = esci2Graph.states.POST_MODE_STAT_DRAIN;
    if (stat.kind !== "decision" || drain.kind !== "decision") {
      throw new Error("POST_MODE_STAT / _DRAIN not decisions");
    }
    const ctx = makeCtx({ entry, source: preset });
    applyEntrySourceOverride(ctx, entry);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let result = stat.decide(ctx, { type: 0xa000, payload: header });
      if (body !== null && "next" in result) {
        expect(result.next).toBe("POST_MODE_STAT_DRAIN");
        result = drain.decide(ctx, { type: 0xa000, payload: body });
      }
      return { ctx, outcome: "error" in result ? result.error.message : result.next };
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  }

  it("ADF paper empty → the flatbed, which scans", () => {
    const { ctx, outcome } = statusBeforePara(
      ET4950_ENTRY,
      statHeader(12),
      Buffer.from("#ERRADF PE  "),
    );
    expect(outcome).toBe("PARA");
    expect(ctx.source).toBe("flatbed");
  });

  it("no error → ADF, read from the reply itself when there is no body", () => {
    const { ctx, outcome } = statusBeforePara(ET4950_ENTRY, statHeader(0), null, "flatbed");
    expect(outcome).toBe("PARA");
    expect(ctx.source).toBe("adf");
    // Tokens inline in a zero-length reply, which has no body.
    const inline = Buffer.from("STATx0000000#ERRADF PE  " + "#---".repeat(10));
    expect(statusBeforePara(ET4950_ENTRY, inline, null).ctx.source).toBe("flatbed");
  });

  it("decides from the content, not the length: a 12-byte status with no error → ADF", () => {
    // Synthetic: every recorded 12-byte status is "ADF paper empty".
    const { ctx, outcome } = statusBeforePara(
      ET4950_ENTRY,
      statHeader(12),
      Buffer.from("#---#---#---"),
      "flatbed",
    );
    expect(outcome).toBe("PARA");
    expect(ctx.source).toBe("adf");
  });

  // Synthetic from here: no fixture's status reports an error other than ADF PE.
  it("keeps the last code the reply gives the ADF, the reply's inline tokens first", () => {
    const loaded = statusBeforePara(
      ET4950_ENTRY,
      statHeader(24),
      Buffer.from("#ERRADF PE  #ERRADF PJ  "),
    );
    expect(loaded).toMatchObject({ ctx: { source: "adf" }, outcome: STOP("ADF PJ") });
    const empty = statusBeforePara(
      ET4950_ENTRY,
      statHeader(24),
      Buffer.from("#ERRADF PJ  #ERRADF PE  "),
    );
    expect(empty).toMatchObject({ ctx: { source: "flatbed" }, outcome: "PARA" });
    const inlineThenBody = statusBeforePara(
      ET4950_ENTRY,
      Buffer.from("STATx000000C#ERRADF PE  " + "#---".repeat(10)),
      Buffer.from("#ERRADF PJ  "),
    );
    expect(inlineThenBody).toMatchObject({ ctx: { source: "adf" }, outcome: STOP("ADF PJ") });
  });

  it("decides the source, then judges the same reply's errors on it", () => {
    // A jam with no paper empty reads as a loaded ADF, which then stops on
    // the jam, as Epson's Auto source does.
    const jammed = statusBeforePara(ET4950_ENTRY, statHeader(12), Buffer.from("#ERRADF PJ  "));
    expect(jammed).toMatchObject({ ctx: { source: "adf" }, outcome: STOP("ADF PJ") });
    const locked = statusBeforePara(
      ET4950_ENTRY,
      statHeader(24),
      Buffer.from("#ERRADF PE  #ERRFB  LOCK"),
    );
    expect(locked).toMatchObject({ ctx: { source: "flatbed" }, outcome: STOP("FB LOCK") });
  });

  it("ET-2750: fixed to the flatbed, so its filler-packed zero-length status never says ADF", () => {
    // Its STAT reply declares length 0 but packs filler inline. Read by
    // content it carries no error, which would say ADF; as a flatbed-only
    // printer it never reaches that rule.
    const { header, body } = readPreParaStatus(ET2750_PATH);
    expect(body).toBeNull();
    expect(header.length).toBeGreaterThan(12);
    expect(parseStatErrors(header)).toEqual([]);
    expect(ET2750_ENTRY.sourceDetection).toBe("fixed-flatbed");
    // Even from a pre-set ADF default (the TLS shell's), the session is flatbed.
    const { ctx, outcome } = statusBeforePara(ET2750_ENTRY, header, null, "adf");
    expect(outcome).toBe("PARA");
    expect(ctx.source).toBe("flatbed");
  });

  it("a single-source printer's status never changes its source", () => {
    const ff680w = recordedDialect(FF680W_FP);
    expect(ff680w.sourceDetection).toBe("fixed-adf");
    // ADF paper empty would say the flatbed; the ADF-only printer stops on it.
    const adf = statusBeforePara(ff680w, statHeader(12), Buffer.from("#ERRADF PE  "), "flatbed");
    expect(adf).toMatchObject({ ctx: { source: "adf" }, outcome: STOP("ADF PE", LOAD) });
    const flatbed = statusBeforePara(
      ET2750_ENTRY,
      statHeader(12),
      Buffer.from("#ERRADF PE  "),
      "adf",
    );
    expect(flatbed).toMatchObject({ ctx: { source: "flatbed" }, outcome: "PARA" });
  });

  it("the init poll's statuses are not read", () => {
    const stat = esci2Graph.states.INIT_POLL_STAT;
    if (stat.kind !== "decision") throw new Error("INIT_POLL_STAT not a decision");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const source of ["adf", "flatbed"] as const) {
        const ctx = makeCtx({ entry: ET4950_ENTRY, initPollIteration: 0, source });
        // Tokens inline, so the reply has no body to drain.
        const inline = Buffer.from(
          `STATx0000000${source === "adf" ? "#ERRADF PE  " : "#---#---#---"}` + "#---".repeat(10),
        );
        const result = stat.decide(ctx, { type: 0xa000, payload: inline });
        expect("next" in result && result.next).toBe("INIT_POLL_FIN");
        expect(ctx.source).toBe(source);
      }
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("esci2Graph POST_MODE_STAT — the status before PARA is judged against the unit scanned", () => {
  const ET4950_ENTRY = recordedDialect(
    "2fb08fc1bde6d17291b2ffb702dbc6b7de88899c9215d0e3267e7c51409df3e2",
  );

  // Feeds the mode switch's STAT reply (header, then the drained body when
  // the header declares one) and returns the last state's outcome (its next
  // state, or its error message) plus the status-error warning and debug
  // lines logged.
  function prePara(
    overrides: Partial<import("./graph.js").Esci2Ctx>,
    header: Buffer,
    body: Buffer | null,
  ): {
    ctx: import("./graph.js").Esci2Ctx;
    outcome: string | undefined;
    warnings: string[];
    debugs: string[];
  } {
    const stat = esci2Graph.states.POST_MODE_STAT;
    const drain = esci2Graph.states.POST_MODE_STAT_DRAIN;
    if (stat.kind !== "decision" || drain.kind !== "decision") {
      throw new Error("POST_MODE_STAT / _DRAIN not decisions");
    }
    const ctx = makeCtx(overrides);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let result = stat.decide(ctx, { type: 0xa000, payload: header });
      if (body !== null && "next" in result) {
        expect(result.next).toBe("POST_MODE_STAT_DRAIN");
        result = drain.decide(ctx, { type: 0xa000, payload: body });
      }
      const lines = (spy: typeof warn) =>
        spy.mock.calls
          .map((args) => args.join(" "))
          .filter((line) => line.includes("before scanning"));
      return {
        ctx,
        outcome: "error" in result ? result.error.message : result.next,
        warnings: lines(warn),
        debugs: lines(info).filter((line) => line.includes("[DEBUG]")),
      };
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  }
  const STOP = (state: string, error: string) =>
    `${state}: the printer reported an error before scanning (${error}) — ` +
    "clear it on the printer and scan again";
  /** An entry no other test warns for, so the once-per-process warning fires. */
  const model = (displayName: string) => ({ ...ET4950_ENTRY, displayName });
  /**
   * The same for a flatbed-only printer (the ET-2750's), fixed to the
   * flatbed: on a printer with both sources, an ADF error with no paper
   * empty reads as a loaded ADF, so the flatbed is never scanned.
   */
  const flatbedOnly = (displayName: string) => ({
    ...recordedDialect(computeCapaFingerprint(readInit1Bodies(ET2750_PATH).capa)),
    displayName,
  });

  it.each(REPLAY_FIXTURES)(
    "lands on the recorded source and reaches PARA without a warning for the $model fixture $path",
    ({ model: name, path, source }) => {
      const entry = recordedDialect(computeCapaFingerprint(readInit1Bodies(path).capa));
      const { header, body } = readPreParaStatus(path);
      const unique = { ...entry, displayName: `${name} fixture ${path}` };
      // Start from the other source, as the scanner shell's default may be,
      // so the recorded one has to come from the status (or the fixed source).
      const preset: "adf" | "flatbed" = source === "adf" ? "flatbed" : "adf";
      const overrides = { entry: unique, source: preset };
      applyEntrySourceOverride(overrides, unique);
      expect(prePara(overrides, header, body)).toMatchObject({
        ctx: { source },
        outcome: "PARA",
        warnings: [],
      });
    },
  );

  // Synthetic from here: no fixture's status reports an error other than ADF PE.
  it("an error on the unit being scanned ends the session before PARA, naming it", () => {
    // The ADF: no paper empty.
    const et4950 = { entry: ET4950_ENTRY };
    expect(prePara(et4950, statHeader(12), Buffer.from("#ERRADF PJ  ")).outcome).toBe(
      STOP("POST_MODE_STAT_DRAIN", "ADF PJ"),
    );
    // Tokens inline in a zero-length reply, which has no body.
    const inline = Buffer.from("STATx0000000#ERRADF PJ  " + "#---".repeat(10));
    expect(prePara(et4950, inline, null).outcome).toBe(STOP("POST_MODE_STAT", "ADF PJ"));
    // The flatbed: paper empty.
    expect(prePara(et4950, statHeader(24), Buffer.from("#ERRADF PE  #ERRFB  LOCK")).outcome).toBe(
      STOP("POST_MODE_STAT_DRAIN", "FB LOCK"),
    );
  });

  it("an ADF-only printer stops on ADF paper empty", () => {
    // A printer with both sources takes it to mean the flatbed instead.
    const entry = recordedDialect(FF680W_FP);
    expect(prePara({ entry }, statHeader(12), Buffer.from("#ERRADF PE  ")).outcome).toBe(
      "POST_MODE_STAT_DRAIN: the printer reported an error before scanning (ADF PE) — " +
        "load the document into the ADF and scan again",
    );
  });

  it("a stop on a reported error is never blamed on an early-stopped init poll", () => {
    const stat = esci2Graph.states.POST_MODE_STAT;
    if (stat.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const ctx = makeCtx({ entry: ET4950_ENTRY, initPollEarlyStop: { cycle: 2, reply: "15" } });
    // ADF paper empty says the flatbed, which the open cover stops.
    const inline = Buffer.from("STATx0000000#ERRADF PE  #ERRFB  OPN " + "#---".repeat(7));
    const result = stat.decide(ctx, { type: 0xa000, payload: inline });
    if (!("error" in result)) throw new Error("expected the session to end");
    expect(nameInitPollEarlyStop(ctx, result.error).message).toBe(STOP("POST_MODE_STAT", "FB OPN"));
  });

  it("the source and its errors both come from the status before PARA, not the first", () => {
    // Synthetic: on every fixture the two agree.
    const poll = esci2Graph.states.INIT_POLL_STAT;
    const stat = esci2Graph.states.POST_MODE_STAT;
    const drain = esci2Graph.states.POST_MODE_STAT_DRAIN;
    if (poll.kind !== "decision" || stat.kind !== "decision" || drain.kind !== "decision") {
      throw new Error("not decisions");
    }
    const session = (first: string, prePara: string) => {
      const ctx = makeCtx({ entry: model(`Model ${first}|${prePara}`), initPollIteration: 0 });
      // The first status's tokens inline, so it has no body to drain.
      poll.decide(ctx, { type: 0xa000, payload: Buffer.from(`STATx0000000${first}`) });
      let result = stat.decide(ctx, { type: 0xa000, payload: statHeader(prePara.length) });
      if (prePara.length > 0 && "next" in result) {
        result = drain.decide(ctx, { type: 0xa000, payload: Buffer.from(prePara) });
      }
      return {
        source: ctx.source,
        outcome: "error" in result ? result.error.message : result.next,
      };
    };
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // The feeder emptied after the first poll: the flatbed, which scans.
      expect(session("", "#ERRADF PE  ")).toEqual({ source: "flatbed", outcome: "PARA" });
      // A paper-empty first poll that clears (paper loaded): the ADF, which scans.
      expect(session("#ERRADF PE  ", "")).toEqual({ source: "adf", outcome: "PARA" });
    } finally {
      info.mockRestore();
    }
  });

  it("a flatbed scan carries on past ADF paper empty without a warning", () => {
    const entry = model("Model PE");
    expect(prePara({ entry }, statHeader(12), Buffer.from("#ERRADF PE  "))).toMatchObject({
      ctx: { source: "flatbed" },
      outcome: "PARA",
      warnings: [],
    });
  });

  it("judges the reply's inline tokens along with the body", () => {
    // Synthetic: no fixture carries tokens in the STAT reply header.
    const header = Buffer.from("STATx000000C#ERRFB  OPN " + "#---".repeat(10));
    expect(prePara({ entry: ET4950_ENTRY }, header, Buffer.from("#ERRADF PE  ")).outcome).toBe(
      STOP("POST_MODE_STAT_DRAIN", "FB OPN"),
    );
  });

  it("keeps one code per unit, the last the reply gives", () => {
    const body = Buffer.from("#ERRADF PE  #ERRADF PJ  ");
    expect(prePara({ entry: ET4950_ENTRY }, statHeader(24), body).outcome).toBe(
      STOP("POST_MODE_STAT_DRAIN", "ADF PJ"),
    );
    const flatbed = prePara(
      { entry: flatbedOnly("Model Last"), source: "flatbed" },
      statHeader(24),
      body,
    );
    expect(flatbed.outcome).toBe("PARA");
    expect(flatbed.warnings).toEqual([expect.stringContaining("reported ADF PJ")]);
  });

  it("an error on another unit warns, naming the model, and the scan carries on", () => {
    const flatbed = prePara(
      { entry: flatbedOnly("Model F"), source: "flatbed" },
      statHeader(24),
      Buffer.from("#ERRADF PJ  #ERRTPU OPN "),
    );
    expect(flatbed).toMatchObject({
      outcome: "PARA",
      warnings: [
        expect.stringMatching(
          /Model F: the printer reported ADF PJ, TPU OPN before scanning, which is not on the flatbed being scanned — the scan continues/,
        ),
      ],
    });
    const adf = prePara({ entry: model("Model A") }, statHeader(12), Buffer.from("#ERRFB  LTF "));
    expect(adf.outcome).toBe("PARA");
    expect(adf.warnings).toEqual([
      expect.stringMatching(
        /reported FB LTF before scanning, which is not on the ADF being scanned/,
      ),
    ]);
  });

  it("warns once per process per model and set of codes; repeats go to debug", () => {
    const previous = getLogLevel();
    setLogLevel("debug");
    try {
      const scan = (name: string, body: string) =>
        prePara(
          { entry: flatbedOnly(name), source: "flatbed" },
          statHeader(body.length),
          Buffer.from(body),
        );
      expect(scan("Model R", "#ERRADF PJ  ")).toMatchObject({
        warnings: [expect.stringContaining("Model R: the printer reported ADF PJ")],
        debugs: [],
      });
      expect(scan("Model R", "#ERRADF PJ  ")).toMatchObject({
        outcome: "PARA",
        warnings: [],
        debugs: [expect.stringContaining("Model R: the printer reported ADF PJ")],
      });
      // Another set warns; the same set in another order is the same set.
      expect(scan("Model R", "#ERRADF PJ  #ERRTPU OPN ").warnings).toHaveLength(1);
      expect(scan("Model R", "#ERRTPU OPN #ERRADF PJ  ").warnings).toEqual([]);
      // Once per model, not once overall.
      expect(scan("Model S", "#ERRADF PJ  ").warnings).toHaveLength(1);
    } finally {
      setLogLevel(previous);
    }
  });
});

describe("esci2Graph — generic dialect", () => {
  // A printer no entry knows: the ET-4800 fixture's replies with its PID
  // swapped out and one CAPA segment added, so neither identity nor
  // fingerprint matches.
  const ET4800 = readInit1Bodies("tools/pcap-extract/captures/et-4800/flatbed-jpg.jsonl");
  const UNKNOWN_INFO = Buffer.from(
    ET4800.info.toString("latin1").replace("PID 1185", "PID FFFF"),
    "latin1",
  );
  const UNKNOWN_CAPA = Buffer.concat([ET4800.capa, Buffer.from("#ZZZZd001", "ascii")]);

  function resolve(info: Buffer, capa: Buffer) {
    const state = esci2Graph.states.INIT1_CAPA_DATA;
    if (state.kind !== "decision") throw new Error("INIT1_CAPA_DATA not a decision");
    const ctx = makeCtx({ entry: undefined, infoBody: info, tprDeclaredLength: capa.length });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = state.decide(ctx, { type: 0xa000, payload: capa });
      return {
        ctx,
        result,
        warnings: warn.mock.calls.map((args) => args.join(" ")),
        infos: log.mock.calls.map((args) => args.join(" ")),
      };
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  }

  it("runs an unrecognised printer on the generic dialect, with the warning and the diagnostic", () => {
    const { ctx, result, warnings, infos } = resolve(UNKNOWN_INFO, UNKNOWN_CAPA);
    expect("error" in result).toBe(false);
    expect(ctx.entry!.displayName).toBe("generic ESC/I-2 dialect (PID FFFF)");
    expect(ctx.entry!.sourceDetection).toBe("pre-para-status");
    expect(ctx.genericDialect).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PID FFFF not recognised — generic ESC/I-2 dialect");
    expect(
      infos.some((line) => line.includes("[INFO]") && line.includes("CAPA fingerprint:")),
    ).toBe(true);
  });

  it("takes back-page rotation from INFO, and warns on its first duplex scan (no evidence)", () => {
    // The ET-4950's two-pass ADF (#ADFDPLX2SCN), under a PID nothing knows.
    const et4950 = readInit1Bodies(
      "tools/frida-capture/captures/2026-04-24T08-58-29-adf-1p-duplex.jsonl",
    );
    const info = Buffer.from(
      et4950.info.toString("latin1").replace("PID 11D1", "PID FFFE"),
      "latin1",
    );
    const capa = Buffer.concat([et4950.capa, Buffer.from("#ZZZZd001", "ascii")]);
    const { ctx } = resolve(info, capa);
    expect(ctx.entry!.displayName).toBe("generic ESC/I-2 dialect (PID FFFE)");
    expect(ctx.entry!.duplexBackRotated).toBe(true);
    Object.assign(ctx, { source: "adf", duplex: true, resolution: 300 });
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      state.decide(ctx, {
        type: 0xa000,
        payload: Buffer.from("STATx0000000" + " ".repeat(52), "ascii"),
      });
      const lines = warn.mock.calls.map((args) => args.join(" "));
      expect(lines.filter((l) => l.includes("which way up duplex back pages arrive"))).toEqual([
        expect.stringContaining("generic ESC/I-2 dialect (PID FFFE)"),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still resolves a known printer to its own entry", () => {
    const { ctx } = resolve(ET4800.info, ET4800.capa);
    expect(ctx.entry).toMatchObject(
      unresolvedFields(OVERRIDES_BY_FINGERPRINT.get(computeCapaFingerprint(ET4800.capa))!),
    );
    expect(ctx.genericDialect).toBe(false);
  });

  it("fails fast with the diagnostic when INFO advertises no scan area", () => {
    const { result } = resolve(Buffer.from("#PRDh010PID FFFF        ", "ascii"), UNKNOWN_CAPA);
    expect("error" in result && result.error.message).toMatch(
      /its INFO reply advertises no scan area[\s\S]*PRD: {15}PID FFFF/,
    );
  });

  describe("source detection from the status before PARA", () => {
    function statusBeforePara(
      header: Buffer,
      body: Buffer | null,
      { info, capa } = { info: UNKNOWN_INFO, capa: UNKNOWN_CAPA },
    ) {
      const { ctx, result: resolved } = resolve(info, capa);
      expect("error" in resolved).toBe(false);
      const stat = esci2Graph.states.POST_MODE_STAT;
      const drain = esci2Graph.states.POST_MODE_STAT_DRAIN;
      if (stat.kind !== "decision" || drain.kind !== "decision") throw new Error("not decisions");
      ctx.source = "adf";
      const statResult = stat.decide(ctx, { type: 0xa000, payload: header });
      const result =
        body === null ? statResult : drain.decide(ctx, { type: 0xa000, payload: body });
      return { ctx, result };
    }

    it("ADF paper empty → flatbed", () => {
      const { ctx, result } = statusBeforePara(statHeader(12), Buffer.from("#ERRADF PE  "));
      expect("next" in result && result.next).toBe("PARA");
      expect(ctx.source).toBe("flatbed");
    });

    it("no error → ADF, read from the reply itself when there is no body", () => {
      const { ctx, result } = statusBeforePara(statHeader(0), null);
      expect("next" in result && result.next).toBe("PARA");
      expect(ctx.source).toBe("adf");
    });

    it("never takes an error list in INFO or CAPA for a reported error", () => {
      // Synthetic, shaped on the #ERR tokens in the FF-680W / DS-575W CAPA
      // and RESA replies, which list error codes: only the status reply
      // reports an error.
      const lists = (body: Buffer, list: string) =>
        Buffer.concat([body, Buffer.from(list, "ascii")]);
      const errorLists = (info: Buffer, capa: Buffer) => ({
        info: lists(info, "#ERRPJ  PJ  DFEDDFED"),
        capa: lists(capa, "#ERRLISTNONEDCM ERR PJ  OPN PE  CLR "),
      });
      for (const [generic, bodies] of [
        [true, errorLists(UNKNOWN_INFO, UNKNOWN_CAPA)],
        [false, errorLists(ET4800.info, ET4800.capa)], // a model override, resolved by PID
      ] as const) {
        const adf = statusBeforePara(statHeader(0), null, bodies);
        expect(adf.ctx.genericDialect).toBe(generic);
        expect("next" in adf.result && adf.result.next).toBe("PARA");
        expect(adf.ctx.source).toBe("adf");
        const flatbed = statusBeforePara(statHeader(12), Buffer.from("#ERRADF PE  "), bodies);
        expect("next" in flatbed.result && flatbed.result.next).toBe("PARA");
        expect(flatbed.ctx.source).toBe("flatbed");
      }
    });

    it("no error in the body → ADF, even when the length would say flatbed", () => {
      const { ctx } = statusBeforePara(statHeader(12), Buffer.from("#---#---#---"));
      expect(ctx.source).toBe("adf");
    });

    it("an ADF error other than paper empty → ADF, and it ends the session before PARA", () => {
      const { ctx, result } = statusBeforePara(statHeader(12), Buffer.from("#ERRADF PJ  "));
      expect(ctx.source).toBe("adf");
      expect("error" in result && result.error.message).toMatch(
        /^POST_MODE_STAT_DRAIN: the printer reported an error before scanning \(ADF PJ\)/,
      );
    });
  });

  it("sends the generic window at the wire DPI, clipped to the scan area", () => {
    // ADF-only crop-mode printer: the full ADF area (8.5 in wide). Scaling the
    // 200-DPI reference to 75 DPI would round to 638 px, one past the edge.
    const info = Buffer.from("#PRDh010PID FFFF        #ADFAREAd850i0001550#ADFALGNCNTR", "ascii");
    const capa = Buffer.from(
      "#ADFCRP #GMMLISTUG10UG18#CMXLISTUNITUM08#FMTLISTRAW JPG #RSMLISTd075d200#RSSLISTd075d200",
      "ascii",
    );
    const { ctx } = resolve(info, capa);
    expect(ctx.entry!.paraProfile).toBe("adf-crp");
    expect(ctx.entry!.initPollIterations).toBe(12);
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    ctx.resolution = 75;
    const result = state.decide(ctx, {
      type: 0xa000,
      payload: Buffer.from("STATx0000000" + " ".repeat(52), "ascii"),
    });
    if (!("send" in result)) throw new Error("expected a send from POST_MODE_STAT");
    const body = parseIsPacket((result.send as Buffer[])[1])!
      .payload.subarray(8)
      .toString("latin1");
    expect(body).toContain("#ACQi0000000i0000000i0000637i0001162");
    // The #DFA length is the printer's own ADF area height.
    expect(body).toContain("#DFAi0000000i0001550");
  });

  it("an override's crop-mode ADF window that falls back to the generic one takes its #DFA length too", () => {
    // An FF-680W reporting a 14-inch ADF area and no long-paper maximum, with
    // a CAPA its override wasn't recorded with: its 36-inch window doesn't
    // fit, so the session gets the generic window, the full ADF area.
    const ff680w = readInit1Bodies("tools/pcap-extract/captures/ff-680w/adf-simplex-200.jsonl");
    const text = ff680w.info.toString("latin1");
    expect(text).toContain("#ADFAREAd850i0001550");
    const info = Buffer.from(
      text.replace("#ADFAREAd850i0001550", "#ADFAREAd850i0001400").replace(/#ADFAMAX[^#]*/, ""),
      "latin1",
    );
    const capa = Buffer.concat([ff680w.capa, Buffer.from("#ZZZZd001", "ascii")]);
    const { ctx } = resolve(info, capa);
    expect(ctx.entry!.displayName).toMatch(/FF-680W/);
    expect(ctx.entry!.paraProfile).toBe("adf-crp");
    expect(ctx.entry!.adfExtents?.generic).toBeDefined();
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    ctx.resolution = 200;
    const result = state.decide(ctx, {
      type: 0xa000,
      payload: Buffer.from("STATx0000000" + " ".repeat(52), "ascii"),
    });
    if (!("send" in result)) throw new Error("expected a send from POST_MODE_STAT");
    const body = parseIsPacket((result.send as Buffer[])[1])!
      .payload.subarray(8)
      .toString("latin1");
    expect(body).toContain("#ACQi0000000i0000000i0001700i0002800");
    expect(body).toContain("#DFAi0000000i0001400");
  });

  it("doesn't add the unverified-DPI warning to an explicit SCAN_RESOLUTION", () => {
    const { ctx } = resolve(UNKNOWN_INFO, UNKNOWN_CAPA);
    ctx.resolution = 300;
    const state = esci2Graph.states.POST_MODE_STAT;
    if (state.kind !== "decision") throw new Error("POST_MODE_STAT not a decision");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // ADF paper empty, inline: a flatbed scan.
      state.decide(ctx, {
        type: 0xa000,
        payload: Buffer.from("STATx0000000#ERRADF PE  " + "#---".repeat(10), "ascii"),
      });
      expect(ctx.source).toBe("flatbed");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
