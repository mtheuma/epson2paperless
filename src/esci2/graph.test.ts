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

  it("INIT1_FS_Y transitions to INIT1_FIN on 0xa000", () => {
    const state = esci2Graph.states.INIT1_FS_Y;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT1_FIN");
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

  it("INIT2_FS_Z transitions to INIT2_FIN on 0xa000", () => {
    const state = esci2Graph.states.INIT2_FS_Z;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT2_FIN");
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

  it("statThenDrain helper states exist for future use (POST_MODE_STAT etc.)", () => {
    // The helper is defined at file scope for T24/T26 use.
    // Verify the graph currently only contains the INIT_POLL inline states.
    expect(esci2Graph.states.INIT_POLL_STAT).toBeDefined();
    expect(esci2Graph.states.INIT_POLL_STAT_DRAIN).toBeDefined();
    expect(esci2Graph.states.INIT_POLL_FIN).toBeDefined();
  });
});
