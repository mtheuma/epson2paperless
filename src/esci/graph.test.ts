import { describe, it, expect } from "vitest";
import { esciGraph, ESCI_TIMEOUT_MS, ESCI_REPLY, type EsciCtx } from "./graph.js";

function makeCtx(overrides: Partial<EsciCtx> = {}): EsciCtx {
  return {
    duplex: false,
    forcedSource: null,
    source: "adf-simplex",
    format: "jpg",
    jpegQuality: 90,
    diagnoseProtocol: false,
    onSourceDetected: undefined,
    inInterPageLoop: false,
    pageCount: 0,
    gammaChannelIdx: 0,
    geom: null,
    imageBuffer: Buffer.alloc(0),
    imageBufferOffset: 0,
    ...overrides,
  };
}

describe("esciGraph (smoke)", () => {
  it("builds with the expected initial state and timeout", () => {
    expect(esciGraph.initial).toBe("WELCOME");
    expect(esciGraph.timeoutMs).toBe(ESCI_TIMEOUT_MS);
    expect(esciGraph.timeoutMs).toBe(60_000);
  });

  it("declares the cleanup states for post-scan-save fallback", () => {
    expect(esciGraph.cleanupStates).toBeDefined();
    expect(esciGraph.cleanupStates!.has("CLEANUP_1")).toBe(true);
    expect(esciGraph.cleanupStates!.has("CLEANUP_2")).toBe(true);
    expect(esciGraph.cleanupStates!.has("UNLOCKING")).toBe(true);
    // POST_STATUS is intentionally NOT a cleanup state.
    expect(esciGraph.cleanupStates!.has("POST_STATUS")).toBe(false);
  });
});

describe("esciGraph WELCOME / LOCKING / INIT", () => {
  it("WELCOME advances to LOCKING on 0x8000 with a lock-packet send", () => {
    const state = esciGraph.states.WELCOME;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0x8000]?.next).toBe("LOCKING");
      expect(state.on[0x8000]?.send).toBeDefined();
    }
  });

  it("LOCKING advances to INIT on 0xa100 with an ESC @ passthru send", () => {
    const state = esciGraph.states.LOCKING;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[0xa100]?.next).toBe("INIT");
      expect(state.on[0xa100]?.send).toBeDefined();
    }
  });

  it("INIT advances to IDENTITY on a valid ESC @ ack", () => {
    const state = esciGraph.states.INIT;
    expect(state.kind).toBe("decision");
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("IDENTITY");
      expect("send" in result && result.send).toBeDefined();
    }
  });

  it("INIT advances to DIAGNOSE_INIT_PROBE on NAK when diagnoseProtocol is true", () => {
    const state = esciGraph.states.INIT;
    if (state.kind === "decision") {
      const ctx = makeCtx({ diagnoseProtocol: true });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x15]) });
      expect("next" in result && result.next).toBe("DIAGNOSE_INIT_PROBE");
    }
  });

  it("INIT errors on NAK when diagnoseProtocol is false", () => {
    const state = esciGraph.states.INIT;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x15]) });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.message).toMatch(/expected ESC @ ack/);
    }
  });

  it("DIAGNOSE_INIT_PROBE always errors with the diagnostic-complete message", () => {
    const state = esciGraph.states.DIAGNOSE_INIT_PROBE;
    if (state.kind === "decision") {
      const ctx = makeCtx({ diagnoseProtocol: true });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.message).toMatch(/diagnostic probe complete/);
    }
  });
});

describe("esciGraph IDENTITY / STATUS_1A / STATUS_1B / STATUS_2", () => {
  it("IDENTITY advances to STATUS_1A on an 80-byte identity reply", () => {
    const state = esciGraph.states.IDENTITY;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.on[ESCI_REPLY]?.next).toBe("STATUS_1A");
      expect(state.on[ESCI_REPLY]?.send).toBeDefined();
    }
  });

  it("STATUS_1A jumps to CLEANUP_1 when inInterPageLoop and byte 0 = 0x81", () => {
    const state = esciGraph.states.STATUS_1A;
    if (state.kind === "decision") {
      const ctx = makeCtx({ inInterPageLoop: true });
      const payload = Buffer.alloc(16);
      payload[0] = 0x81;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("CLEANUP_1");
      expect(ctx.inInterPageLoop).toBe(false);
    }
  });

  it("STATUS_1A advances to STATUS_1B otherwise", () => {
    const state = esciGraph.states.STATUS_1A;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.alloc(16) });
      expect("next" in result && result.next).toBe("STATUS_1B");
    }
  });

  it("STATUS_1B routes to ADF_IDENTITY_A in the inter-page loop", () => {
    const state = esciGraph.states.STATUS_1B;
    if (state.kind === "decision") {
      const ctx = makeCtx({ inInterPageLoop: true });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.alloc(16) });
      expect("next" in result && result.next).toBe("ADF_IDENTITY_A");
    }
  });

  it("STATUS_1B routes to SOURCE_ACK1 with ESC e + 0x01 probe initially", () => {
    const state = esciGraph.states.STATUS_1B;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.alloc(16) });
      expect("next" in result && result.next).toBe("SOURCE_ACK1");
      expect("send" in result && Array.isArray(result.send)).toBe(true);
    }
  });

  it("STATUS_2 routes to RESET_PAREN when byte 0 = 0x81 (busy)", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.alloc(16);
      payload[0] = 0x81;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("RESET_PAREN");
      expect(ctx.source).toBe("flatbed");
    }
  });

  it("STATUS_2 routes to ADF_PRESRC_ACK1 when byte 0 = 0x01 (ADF) and duplex=false", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.alloc(16);
      payload[0] = 0x01;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("ADF_PRESRC_ACK1");
      expect(ctx.source).toBe("adf-simplex");
    }
  });

  it("STATUS_2 routes to ADF_PRESRC_ACK1 with adf-duplex source when duplex=true", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx({ duplex: true });
      const payload = Buffer.alloc(16);
      payload[0] = 0x01;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("ADF_PRESRC_ACK1");
      expect(ctx.source).toBe("adf-duplex");
    }
  });

  it("STATUS_2 errors with the compatibility-issue message on unrecognised byte", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.alloc(16);
      payload[0] = 0x42;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error.message).toMatch(/Unrecognised FS F status 0x42/);
    }
  });

  it("STATUS_2 forcedSource shortcuts the byte-0 detection", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx({ forcedSource: "adf-duplex" });
      const payload = Buffer.alloc(16);
      payload[0] = 0x42;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect(ctx.source).toBe("adf-duplex");
      // 0x42 is not 0x81 and ctx.source !== "flatbed", so we expect ADF branch.
      expect("next" in result && result.next).toBe("ADF_PRESRC_ACK1");
    }
  });

  it("STATUS_2 calls onSourceDetected with the resolved source", () => {
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const seen: string[] = [];
      const ctx = makeCtx({ onSourceDetected: (s) => seen.push(s) });
      const payload = Buffer.alloc(16);
      payload[0] = 0x01;
      state.decide(ctx, { type: ESCI_REPLY, payload });
      expect(seen).toEqual(["adf-simplex"]);
    }
  });
});

describe("esciGraph helper-generated *_ACK1 / *_ACK2 states", () => {
  for (const prefix of ["SOURCE", "ADF_PRESRC", "RESET_SRC", "ADF_PDF_SRC", "ADF_CLEANUP"]) {
    it(`${prefix}_ACK1 / ${prefix}_ACK2 are static states that validate ack byte 0x06`, () => {
      const ack1 = esciGraph.states[`${prefix}_ACK1`];
      const ack2 = esciGraph.states[`${prefix}_ACK2`];
      expect(ack1?.kind).toBe("static");
      expect(ack2?.kind).toBe("static");
      if (ack1?.kind === "static") {
        expect(ack1.on[ESCI_REPLY]?.next).toBe(`${prefix}_ACK2`);
        expect(ack1.on[ESCI_REPLY]?.validate?.(Buffer.from([0x06]))).toBe(true);
        expect(ack1.on[ESCI_REPLY]?.validate?.(Buffer.from([0x15]))).toBe(false);
      }
    });
  }
});

describe("esciGraph reset / gamma / window / start cycles", () => {
  it("RESET_PAREN advances on a 1-byte reply", () => {
    const state = esciGraph.states.RESET_PAREN;
    if (state.kind === "static") {
      expect(state.on[ESCI_REPLY]?.next).toBe("RESET_INIT");
      expect(state.on[ESCI_REPLY]?.validate?.(Buffer.from([0x06]))).toBe(true);
      expect(state.on[ESCI_REPLY]?.validate?.(Buffer.from([0x80]))).toBe(true);
    }
  });

  it("GAMMA_DATA loops through three channels then advances to WINDOW_CMD", () => {
    const state = esciGraph.states.GAMMA_DATA;
    if (state.kind === "decision") {
      const ctx = makeCtx({ gammaChannelIdx: 0 });
      let result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("GAMMA_CMD");
      expect(ctx.gammaChannelIdx).toBe(1);

      result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("GAMMA_CMD");
      expect(ctx.gammaChannelIdx).toBe(2);

      result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("WINDOW_CMD");
      expect(ctx.gammaChannelIdx).toBe(0); // reset for next session
    }
  });

  it("START routes to START_POLL when chunkSize=0", () => {
    const state = esciGraph.states.START;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      // 14-byte FS G reply: status(2) + chunkSize(4) + bytesPerLine(4) + totalLines(4)
      const payload = Buffer.alloc(14);
      payload.writeUInt16BE(0x0000, 0); // status
      payload.writeUInt32LE(0, 2); // chunkSize = 0 → poll path
      payload.writeUInt32LE(1, 6);
      payload.writeUInt32LE(1, 10);
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("START_POLL");
    }
  });

  it("START routes to IMG_RECEIVING when chunkSize > 0 and allocates the per-page buffer", () => {
    const state = esciGraph.states.START;
    if (state.kind === "decision") {
      const ctx = makeCtx({ source: "flatbed", format: "jpg" });
      const payload = Buffer.alloc(14);
      payload.writeUInt32LE(0x1000, 2); // chunkSize
      payload.writeUInt32LE(0x06d6, 6);
      payload.writeUInt32LE(7002, 10);
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("IMG_RECEIVING");
      expect(ctx.imageBuffer.length).toBeGreaterThan(0);
      expect(ctx.geom).not.toBeNull();
      expect(ctx.imageBuffer.length).toBe(ctx.geom!.widthPx * ctx.geom!.heightPx * 3);
    }
  });

  it("START_POLL advances to START_POLL_READY on byte 0 = 0x01", () => {
    const state = esciGraph.states.START_POLL;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.alloc(16);
      payload[0] = 0x01;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("START_POLL_READY");
    }
  });

  it("START_POLL re-loops on byte 0 ≠ 0x01", () => {
    const state = esciGraph.states.START_POLL;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const payload = Buffer.alloc(16);
      payload[0] = 0x00;
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("START_POLL");
    }
  });
});

describe("esciGraph IMG_RECEIVING / PAGE_EJECT_WAIT / cleanup", () => {
  // Stub geometry sized so widthPx * heightPx * 3 = the test's pre-allocated
  // imageBuffer length. flush.encode() is never invoked from these tests, so
  // dpi / topYOffsetPx values don't matter — only the dimensions feed back
  // into the IMG_RECEIVING flush spec.
  const stubGeom = { dpi: 300, widthPx: 1, heightPx: 2, topYOffsetPx: 0 };

  it("IMG_RECEIVING accumulates mid-page chunks without advancing", () => {
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const ctx = makeCtx({
        imageBuffer: Buffer.alloc(100),
        imageBufferOffset: 0,
      });
      // IS-0xa200 chunk: leading status byte then pixel bytes
      const chunk = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(20, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: chunk });
      expect("next" in result && result.next).toBe("IMG_RECEIVING");
      expect(ctx.imageBufferOffset).toBe(20);
      expect("flushPage" in result).toBe(false);
    }
  });

  it("IMG_RECEIVING flushes the page on completion (flatbed → POST_STATUS)", () => {
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const ctx = makeCtx({
        source: "flatbed",
        geom: stubGeom,
        imageBuffer: Buffer.alloc(6),
        imageBufferOffset: 0,
      });
      const chunk = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(6, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: chunk });
      if ("error" in result) throw new Error("unexpected error result");
      expect(result.next).toBe("POST_STATUS");
      expect(result.flushPage?.side).toBe("front");
      expect(ctx.pageCount).toBe(1);
    }
  });

  it("IMG_RECEIVING flushes and routes to PAGE_EJECT_WAIT for ADF", () => {
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const ctx = makeCtx({
        source: "adf-duplex",
        geom: stubGeom,
        imageBuffer: Buffer.alloc(6),
        imageBufferOffset: 0,
      });
      const chunk = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(6, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: chunk });
      if ("error" in result) throw new Error("unexpected error result");
      expect(result.next).toBe("PAGE_EJECT_WAIT");
      expect(result.flushPage?.side).toBe("front"); // page 1 = front
    }
  });

  it("IMG_RECEIVING marks back side on even ADF-duplex pages", () => {
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const ctx = makeCtx({
        source: "adf-duplex",
        pageCount: 1, // about to flush page 2 (back)
        geom: stubGeom,
        imageBuffer: Buffer.alloc(6),
        imageBufferOffset: 0,
      });
      const chunk = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(6, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: chunk });
      if ("error" in result) throw new Error("unexpected error result");
      expect(result.flushPage?.side).toBe("back");
    }
  });

  it("PAGE_EJECT_WAIT sets inInterPageLoop and routes to STATUS_1A", () => {
    const state = esciGraph.states.PAGE_EJECT_WAIT;
    if (state.kind === "decision") {
      const ctx = makeCtx({ inInterPageLoop: false });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("STATUS_1A");
      expect(ctx.inInterPageLoop).toBe(true);
    }
  });

  it("CLEANUP_1 routes to ADF_CLEANUP_ACK1 for ADF sources", () => {
    const state = esciGraph.states.CLEANUP_1;
    if (state.kind === "decision") {
      const ctx = makeCtx({ source: "adf-simplex" });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x80]) });
      expect("next" in result && result.next).toBe("ADF_CLEANUP_ACK1");
    }
  });

  it("CLEANUP_1 routes to CLEANUP_2 for flatbed", () => {
    const state = esciGraph.states.CLEANUP_1;
    if (state.kind === "decision") {
      const ctx = makeCtx({ source: "flatbed" });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x80]) });
      expect("next" in result && result.next).toBe("CLEANUP_2");
    }
  });

  it("UNLOCKING is a static state with onEnter sending the unlock packet", () => {
    const state = esciGraph.states.UNLOCKING;
    expect(state.kind).toBe("static");
    if (state.kind === "static") {
      expect(state.onEnter).toBeDefined();
      expect(state.on[0xa101]?.next).toBe("DONE");
    }
  });
});
