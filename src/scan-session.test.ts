// src/scan-session.test.ts

import { describe, it, expect } from "vitest";
import { createGraph, decision } from "./scan-session.js";

describe("createGraph", () => {
  it("builds an empty graph with the given initial state", () => {
    type Ctx = { count: number };
    const g = createGraph<Ctx>("START", 30_000);
    g.state("START", { on: {} });
    const graph = g.build();
    expect(graph.initial).toBe("START");
    expect(graph.timeoutMs).toBe(30_000);
    expect(graph.states.START).toBeDefined();
  });

  it("rejects building when initial state is undefined", () => {
    const g = createGraph<{}>("START", 30_000);
    expect(() => g.build()).toThrow(/Initial state 'START' not defined/);
  });

  it("rejects duplicate state names", () => {
    const g = createGraph<{}>("S", 30_000);
    g.state("S", { on: {} });
    expect(() => g.state("S", { on: {} })).toThrow(/Duplicate state/);
  });

  it('rejects defining the reserved "DONE" state', () => {
    const g = createGraph<{}>("S", 30_000);
    expect(() => g.state("DONE", { on: {} })).toThrow(/"DONE" is reserved/);
  });
});

describe("decision", () => {
  it("wraps a function as a DecisionDef", () => {
    const def = decision<{}>(() => ({ next: "NEXT" }));
    expect(def.__decision).toBe(true);
    const result = def.decide({}, { type: 0, payload: Buffer.alloc(0) });
    expect(result).toEqual({ next: "NEXT" });
  });
});
