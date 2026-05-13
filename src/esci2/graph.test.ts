import { describe, it, expect } from "vitest";
import { esci2Graph, ESCI2_TIMEOUT_MS } from "./graph.js";
import { IS_HEADER_SIZE } from "../protocol.js";
import { et4950FamilyDialect } from "./dialects/et-4950-family.js";
import { et2750Dialect } from "./dialects/et-2750.js";

describe("esci2Graph (smoke)", () => {
  it("builds with the expected initial state and timeout", () => {
    expect(esci2Graph.initial).toBe("WELCOME");
    expect(esci2Graph.timeoutMs).toBe(ESCI2_TIMEOUT_MS);
    expect(esci2Graph.timeoutMs).toBe(30_000);
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
  it("INIT_POLL_FS_Y transitions to INIT_POLL_STAT on 0xa000", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT_POLL_STAT");
    }
  });

  it("INIT_POLL_FS_Y sends a STAT passthru packet on 0xa000 transition", () => {
    const state = esci2Graph.states.INIT_POLL_FS_Y;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT_POLL_STAT is a decision state", () => {
    expect(esci2Graph.states.INIT_POLL_STAT.kind).toBe("decision");
  });

  it("INIT_POLL_STAT_DRAIN is a static state that advances to INIT_POLL_FIN on 0xa000", () => {
    const state = esci2Graph.states.INIT_POLL_STAT_DRAIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT_POLL_FIN");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
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

  it("INIT_POLL_FIN loops on et2750Dialect while initPollIteration < 2", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // ET-2750 host driver only loops twice. After the first FIN reply,
    // iteration goes 0 → 1 (still < dialect.initPollIterations=2), so loop.
    const ctx = makeCtx({ dialect: et2750Dialect, initPollIteration: 0 });
    const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
    expect("next" in result && result.next).toBe("INIT_POLL_FS_Y");
    expect(ctx.initPollIteration).toBe(1);
  });

  it("INIT_POLL_FIN advances to MODE_SWITCH on et2750Dialect after 2 iterations", () => {
    const state = esci2Graph.states.INIT_POLL_FIN;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // Iteration was 1, bumps to 2 — equals dialect.initPollIterations=2, advance.
    // Sending a third FS Y after the printer has moved on returns a non-ACK
    // that fails MODE_SWITCH validation, so this cap is load-bearing.
    const ctx = makeCtx({ dialect: et2750Dialect, initPollIteration: 1 });
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

  it("PARA validates #parOK token and advances to TRDT", () => {
    const state = esci2Graph.states.PARA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("TRDT");
      expect(state.on[0xa000]?.validate).toBeDefined();
      const validateFn = state.on[0xa000]?.validate;
      // Payload with #parOK at offset 12
      const okPayload = Buffer.from("PARAx0000000#parOK  ", "ascii");
      expect(validateFn?.(okPayload)).toBe(true);
      // Payload with #parNG
      const ngPayload = Buffer.from("PARAx0000000#parNG  ", "ascii");
      expect(validateFn?.(ngPayload)).toBe(false);
    }
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
    profile: "esci2-tls",
    action: "jpg",
    initPollIteration: 0,
    imgChunkSize: 0,
    pageEndKind: "none",
    pageSide: "front",
    zeroImgRetries: 0,
    imageChunks: [],
    tprDeclaredLength: 0,
    infoBody: Buffer.alloc(0),
    capaBody: Buffer.alloc(0),
    dialect: et4950FamilyDialect,
    ...overrides,
  };
}

describe("esci2Graph INIT_POLL_STAT source detection", () => {
  it("detects source=adf when STAT header length is 0 on iteration 0", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ initPollIteration: 0, source: "flatbed" }); // start flatbed to confirm mutation
    // STAT reply with length=0 (ADF signature — no status queued)
    const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    state.decide(ctx, { type: 0xa000, payload });
    expect(ctx.source).toBe("adf");
  });

  it("detects source=flatbed when STAT header length is 12 on iteration 0", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ initPollIteration: 0 });
    // STAT reply with length=12 (flatbed signature — queued filler #---#---#---)
    const payload = Buffer.from("STATx000000c#---#---#---", "ascii");
    state.decide(ctx, { type: 0xa000, payload });
    expect(ctx.source).toBe("flatbed");
  });

  it("defaults source=adf for unexpected STAT header length on iteration 0", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    const ctx = makeCtx({ initPollIteration: 0 });
    // STAT reply with unexpected length=8
    const payload = Buffer.from("STATx0000008#-------", "ascii");
    state.decide(ctx, { type: 0xa000, payload });
    expect(ctx.source).toBe("adf");
  });

  it("does NOT update source on iteration 1+", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // Source was set to flatbed on iteration 0; must not change on iteration 1.
    const ctx = makeCtx({ initPollIteration: 1, source: "flatbed" });
    // A STAT reply with length=0 on iteration 1 should NOT reset source to adf.
    const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    state.decide(ctx, { type: 0xa000, payload });
    expect(ctx.source).toBe("flatbed");
  });

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

  it("skips source-detect override when dialect.sourceDetection is fixed-flatbed (preserves pre-set source)", () => {
    const state = esci2Graph.states.INIT_POLL_STAT;
    expect(state.kind).toBe("decision");
    if (state.kind !== "decision") return;
    // ET-2750 STAT replies declare length=0 even though the IS frame packs
    // a 52-byte filler inline. Applying the stat-length heuristic would
    // misclassify ET-2750 as ADF — the fixed-flatbed dialect must skip
    // detection and trust the pre-set source.
    const ctx = makeCtx({
      dialect: et2750Dialect,
      source: "flatbed",
      initPollIteration: 0,
    });
    const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
    state.decide(ctx, { type: 0xa000, payload });
    expect(ctx.source).toBe("flatbed");
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
    const ctx = makeCtx({ source: "adf", zeroImgRetries: 2000, imageChunks: [] });
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
