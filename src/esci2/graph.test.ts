import { describe, it, expect } from "vitest";
import { esci2Graph, ESCI2_TIMEOUT_MS } from "./graph.js";

describe("esci2Graph (smoke)", () => {
  it("builds with the expected initial state and timeout", () => {
    expect(esci2Graph.initial).toBe("WELCOME");
    expect(esci2Graph.timeoutMs).toBe(ESCI2_TIMEOUT_MS);
    expect(esci2Graph.timeoutMs).toBe(30_000);
  });

  it("has a WELCOME state defined", () => {
    expect(esci2Graph.states.WELCOME).toBeDefined();
  });

  it("has globalIgnoreFilter defined for empty 0xa000 envelopes", () => {
    expect(esci2Graph.globalIgnoreFilter).toBeDefined();
    // Empty 0xa000 → ignored
    expect(esci2Graph.globalIgnoreFilter!({ type: 0xa000, payload: Buffer.alloc(0) })).toBe(true);
    // Non-empty 0xa000 → not ignored
    expect(esci2Graph.globalIgnoreFilter!({ type: 0xa000, payload: Buffer.from([0x01]) })).toBe(
      false,
    );
    // Other types → not ignored
    expect(esci2Graph.globalIgnoreFilter!({ type: 0x2000, payload: Buffer.alloc(0) })).toBe(false);
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 2,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.alloc(0) });
      expect("next" in result && result.next).toBe("MODE_SWITCH");
      expect(ctx.initPollIteration).toBe(3);
    }
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const payload = Buffer.from("INFOx0000020" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("INIT1_INFO_DATA");
      expect("send" in result && result.send).toBeDefined();
    }
  });

  it("INIT1_INFO_DATA advances to INIT1_CAPA_META with CAPA send", () => {
    const state = esci2Graph.states.INIT1_INFO_DATA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT1_CAPA_META");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT1_CAPA_META is a decision state", () => {
    expect(esci2Graph.states.INIT1_CAPA_META.kind).toBe("decision");
  });

  it("INIT1_CAPA_DATA advances to INIT1_FIN with FIN send", () => {
    const state = esci2Graph.states.INIT1_CAPA_DATA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT1_FIN");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });
});

describe("esci2Graph T24 — twoPhaseRead (INIT2 TPR)", () => {
  it("INIT2_INFO_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_INFO_META.kind).toBe("decision");
  });

  it("INIT2_INFO_DATA advances to INIT2_CAPA_META", () => {
    const state = esci2Graph.states.INIT2_INFO_DATA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_CAPA_META");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT2_CAPA_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_CAPA_META.kind).toBe("decision");
  });

  it("INIT2_CAPA_DATA advances to INIT2_RESA_META with RESA send", () => {
    const state = esci2Graph.states.INIT2_CAPA_DATA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_RESA_META");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
  });

  it("INIT2_RESA_META is a decision state", () => {
    expect(esci2Graph.states.INIT2_RESA_META.kind).toBe("decision");
  });

  it("INIT2_RESA_DATA advances to INIT2_FIN with FIN send", () => {
    const state = esci2Graph.states.INIT2_RESA_DATA;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_FIN");
      expect(state.on[0xa000]?.send).toBeDefined();
    }
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const payload = Buffer.from("STATx0000000" + " ".repeat(52), "ascii");
      const result = state.decide(ctx, { type: 0xa000, payload });
      expect("next" in result && result.next).toBe("PARA");
      // send should be an array (para header + body)
      expect("send" in result && Array.isArray(result.send)).toBe(true);
    }
  });

  it("POST_MODE_STAT_DRAIN advances to PARA with para send array", () => {
    const state = esci2Graph.states.POST_MODE_STAT_DRAIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("PARA");
      expect(Array.isArray(state.on[0xa000]?.send)).toBe(true);
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const result = state.decide(ctx, { type: 0xa000, payload: Buffer.from("bad") });
      expect("error" in result).toBe(true);
    }
  });

  it("IMG_META errors on #ERR token", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
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
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
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
      const ctx = {
        duplex: true,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const payload = Buffer.from("IMG x0000010#typIMGB", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageSide).toBe("back");
    }
  });

  it("IMG_META sets pageEndKind=more for ADF #pen without #lft", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const payload = Buffer.from("IMG x0000010#pen#typIMGF", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("more");
    }
  });

  it("IMG_META sets pageEndKind=last for ADF #pen + #lftd000", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = {
        duplex: false,
        source: "adf" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      const payload = Buffer.from("IMG x0000010#pen#lftd000", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("last");
    }
  });

  it("IMG_META sets pageEndKind=last for flatbed #pen (no #lft)", () => {
    const state = esci2Graph.states.IMG_META;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = {
        duplex: false,
        source: "flatbed" as const,
        initPollIteration: 0,
        imgChunkSize: 0,
        pageEndKind: "none" as const,
        pageSide: "front" as const,
        zeroImgRetries: 0,
        postScanCycle: 1 as const,
      };
      // Flatbed emits #pen but never #lft; source=flatbed must resolve "last".
      const payload = Buffer.from("IMG x0000010#pen#typIMGF", "ascii");
      state.decide(ctx, { type: 0xa000, payload });
      expect(ctx.pageEndKind).toBe("last");
    }
  });
});

describe("esci2Graph INIT_POLL_STAT source detection", () => {
  function makeCtx(
    overrides: Partial<import("./graph.js").Esci2Ctx> = {},
  ): import("./graph.js").Esci2Ctx {
    return {
      duplex: false,
      source: "adf",
      initPollIteration: 0,
      imgChunkSize: 0,
      pageEndKind: "none",
      pageSide: "front",
      zeroImgRetries: 0,
      postScanCycle: 1,
      ...overrides,
    };
  }

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
});
