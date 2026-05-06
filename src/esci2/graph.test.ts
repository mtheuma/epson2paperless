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

  it("INIT2_FIN transitions to INIT_POLL_FS_Y (T23 territory)", () => {
    const state = esci2Graph.states.INIT2_FIN;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa000]?.next).toBe("INIT_POLL_FS_Y");
    }
  });
});
