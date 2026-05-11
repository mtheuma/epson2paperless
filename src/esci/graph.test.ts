import { describe, it, expect } from "vitest";
import { esciGraph, ESCI_TIMEOUT_MS, ESCI_REPLY, type EsciCtx } from "./graph.js";

function makeCtx(overrides: Partial<EsciCtx> = {}): EsciCtx {
  return {
    duplex: false,
    forcedSource: null,
    source: "adf-simplex",
    sourceDetected: false,
    format: "jpg",
    jpegQuality: 90,
    diagnoseProtocol: false,
    inInterPageLoop: false,
    pageCount: 0,
    gammaChannelIdx: 0,
    geom: null,
    imageBuffer: Buffer.alloc(0),
    imageBufferOffset: 0,
    deferredImageChunks: [],
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

  it("STATUS_2 sets ctx.sourceDetected once the source has been resolved", () => {
    // The graph-level contract is: STATUS_2 records the decision on the
    // ctx flag; the scanner shell reads the flag post-DONE to decide
    // whether to fire the public onSourceDetected hook (success-only).
    const state = esciGraph.states.STATUS_2;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      expect(ctx.sourceDetected).toBe(false);
      const payload = Buffer.alloc(16);
      payload[0] = 0x01;
      state.decide(ctx, { type: ESCI_REPLY, payload });
      expect(ctx.sourceDetected).toBe(true);
      expect(ctx.source).toBe("adf-simplex");
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

  it("START drains deferred chunks into the new page buffer (issue #71 P1)", () => {
    // Reviewer's catch on PR #79: if a slow encode let the printer stash
    // the entire next page during PAGE_ENCODING_DRAIN, no later wire
    // chunk arrives to trigger IMG_RECEIVING's drain — the scan sits
    // until timeout. START is the proactive drain point: after the new
    // page's buffer is allocated, drain the queue before IMG_RECEIVING
    // is entered.
    const state = esciGraph.states.START;
    if (state.kind === "decision") {
      const deferred = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(50, 0xa0)]);
      const ctx = makeCtx({
        source: "adf-duplex",
        format: "jpg",
        deferredImageChunks: [deferred],
      });
      const payload = Buffer.alloc(14);
      payload.writeUInt32LE(0x1000, 2);
      payload.writeUInt32LE(0x06d6, 6);
      payload.writeUInt32LE(7002, 10);
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      expect("next" in result && result.next).toBe("IMG_RECEIVING");
      // 50 pixel bytes from the deferred chunk landed in the new buffer.
      expect(ctx.imageBufferOffset).toBe(50);
      expect(ctx.imageBuffer.subarray(0, 50).every((b) => b === 0xa0)).toBe(true);
      // Queue is drained.
      expect(ctx.deferredImageChunks).toHaveLength(0);
    }
  });

  it("START emits flush transition when deferred chunks alone fill the next page (issue #71 P1)", () => {
    // The bug scenario the reviewer flagged: encoder is slower than the
    // printer for a duplex back-page; the entire back-page is stashed
    // during PAGE_ENCODING_DRAIN. Without START's drain, IMG_RECEIVING
    // would sit idle until timeout. With it, the page is recognised
    // complete here and a flush transition fires immediately.
    //
    // Geometry is fixed by geometry() — PDF format gives ~26MB
    // (2478 × 3501 × 3); allocUnsafe makes the deferred chunk effectively
    // free (pool-allocated, no zero-fill).
    const state = esciGraph.states.START;
    if (state.kind === "decision") {
      const pdfBufferSize = 2478 * 3501 * 3;
      const overflowing = Buffer.allocUnsafe(pdfBufferSize + 1);
      overflowing[0] = 0x01; // leading status byte that appendImageChunk strips
      const ctx = makeCtx({
        source: "adf-duplex",
        format: "pdf",
        pageCount: 1, // about to flush page 2 (back)
        deferredImageChunks: [overflowing],
      });
      const payload = Buffer.alloc(14);
      payload.writeUInt32LE(0x1000, 2);
      payload.writeUInt32LE(0x06d6, 6);
      payload.writeUInt32LE(7002, 10);
      const result = state.decide(ctx, { type: ESCI_REPLY, payload });
      if ("error" in result) throw new Error("unexpected error result");
      // Flush transition fired without any wire chunk needed.
      expect(result.next).toBe("PAGE_ENCODING_DRAIN");
      expect(result.flushPage?.side).toBe("back");
      // pageCount advanced; ctx.imageBuffer reset.
      expect(ctx.pageCount).toBe(2);
      expect(ctx.imageBufferOffset).toBe(0);
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

describe("esciGraph IMG_RECEIVING / PAGE_ENCODING_DRAIN / cleanup", () => {
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

  it("IMG_RECEIVING flushes and routes to PAGE_ENCODING_DRAIN for ADF", () => {
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
      expect(result.next).toBe("PAGE_ENCODING_DRAIN");
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

  it("PAGE_ENCODING_DRAIN: 0xa000 eject ACK sets inInterPageLoop and routes to STATUS_1A", () => {
    const state = esciGraph.states.PAGE_ENCODING_DRAIN;
    if (state.kind === "decision") {
      const ctx = makeCtx({ inInterPageLoop: false });
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06]) });
      expect("next" in result && result.next).toBe("STATUS_1A");
      expect(ctx.inInterPageLoop).toBe(true);
    }
  });

  it("PAGE_ENCODING_DRAIN: trailing 0xa200 chunk is stashed and self-loops (issue #71)", () => {
    // The regression: in duplex / multi-page scans the printer eagerly
    // streams the next page's first bytes before our flushPage encode
    // completes. Pre-v0.4.0 absorbed them in a PAGE_ENCODING state; the
    // v0.4.0 rebuild lost this, sending the chunks to PAGE_EJECT_WAIT
    // which rejected anything that wasn't a 0xa000 ACK.
    const state = esciGraph.states.PAGE_ENCODING_DRAIN;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const chunk = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(12, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: chunk });
      expect("next" in result && result.next).toBe("PAGE_ENCODING_DRAIN");
      expect(ctx.deferredImageChunks).toHaveLength(1);
      expect(ctx.deferredImageChunks[0]).toBe(chunk);
      // No state mutation that would affect the eject-ACK path.
      expect(ctx.inInterPageLoop).toBe(false);
    }
  });

  it("PAGE_ENCODING_DRAIN: stashes multiple trailing 0xa200 chunks in order", () => {
    const state = esciGraph.states.PAGE_ENCODING_DRAIN;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const first = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(4, 0xa0)]);
      const second = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(4, 0xb0)]);
      state.decide(ctx, { type: 0xa200, payload: first });
      state.decide(ctx, { type: 0xa200, payload: second });
      expect(ctx.deferredImageChunks).toEqual([first, second]);
    }
  });

  it("PAGE_ENCODING_DRAIN: rejects unexpected packet types", () => {
    const state = esciGraph.states.PAGE_ENCODING_DRAIN;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: 0xa100, payload: Buffer.from([0x00]) });
      expect("error" in result).toBe(true);
    }
  });

  it("PAGE_ENCODING_DRAIN: rejects 0xa000 with wrong length", () => {
    const state = esciGraph.states.PAGE_ENCODING_DRAIN;
    if (state.kind === "decision") {
      const ctx = makeCtx();
      const result = state.decide(ctx, { type: ESCI_REPLY, payload: Buffer.from([0x06, 0x06]) });
      expect("error" in result).toBe(true);
    }
  });

  it("IMG_RECEIVING: drains deferredImageChunks into the new page buffer before processing the incoming chunk", () => {
    // Engine flow after PAGE_ENCODING_DRAIN exits and the inter-page
    // loop walks back to IMG_RECEIVING: first incoming 0xa200 triggers
    // the drain prelude. Both deferred + incoming bytes land in the
    // fresh imageBuffer.
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const deferred = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(5, 0xa0)]);
      const ctx = makeCtx({
        imageBuffer: Buffer.alloc(100),
        imageBufferOffset: 0,
        deferredImageChunks: [deferred],
      });
      const incoming = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(7, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: incoming });
      expect("next" in result && result.next).toBe("IMG_RECEIVING");
      // Deferred 5 bytes + incoming 7 bytes = 12 pixel bytes total.
      expect(ctx.imageBufferOffset).toBe(12);
      // First five bytes are the deferred chunk's pixel tail.
      expect(ctx.imageBuffer.subarray(0, 5).every((b) => b === 0xa0)).toBe(true);
      // Next seven are the incoming chunk's pixel tail.
      expect(ctx.imageBuffer.subarray(5, 12).every((b) => b === 0xb0)).toBe(true);
      // Queue is consumed.
      expect(ctx.deferredImageChunks).toHaveLength(0);
    }
  });

  it("IMG_RECEIVING: deferred-chunk drain that fills the page re-stashes the incoming chunk for the next page", () => {
    // Defensive guard for the (unlikely) case where deferred chunks
    // alone exceed the new page's buffer. The remaining deferred
    // entries + the incoming chunk get re-stashed so the next page's
    // IMG_RECEIVING can drain them.
    const state = esciGraph.states.IMG_RECEIVING;
    if (state.kind === "decision") {
      const stubGeom2 = { dpi: 300, widthPx: 1, heightPx: 4, topYOffsetPx: 0 };
      const fillsBuffer = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(12, 0xa0)]);
      const extraDeferred = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(4, 0xc0)]);
      const ctx = makeCtx({
        source: "adf-duplex",
        geom: stubGeom2,
        imageBuffer: Buffer.alloc(12),
        imageBufferOffset: 0,
        deferredImageChunks: [fillsBuffer, extraDeferred],
      });
      const incoming = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(4, 0xb0)]);
      const result = state.decide(ctx, { type: 0xa200, payload: incoming });
      if ("error" in result) throw new Error("unexpected error result");
      // Page completes mid-drain → flushPage transition emitted.
      expect(result.next).toBe("PAGE_ENCODING_DRAIN");
      expect(result.flushPage?.side).toBe("front");
      // The unconsumed deferred chunk + the incoming chunk are re-stashed.
      expect(ctx.deferredImageChunks).toEqual([extraDeferred, incoming]);
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
