import { describe, it, expect } from "vitest";
import { buildFf680wDummyJobWritePacket, buildFf680wJobReadPacket } from "./ff680w-job-control.js";

describe("FF-680W job-control packet builders", () => {
  it("builds the JobList dummy JOBW packet observed in the Mac trace", () => {
    expect(buildFf680wDummyJobWritePacket().toString("hex")).toBe(
      "49532300000c0000003a00000000003200000000" +
        "4a4f425700000000000000000000000000000000011a18000000000a0000" +
        "440075006d006d00790003000000020000020100",
    );
  });

  it("builds the JobNumber JOBR packet observed in the Mac trace", () => {
    expect(buildFf680wJobReadPacket().toString("hex")).toBe(
      "49532300000c0000000c000000000004000000084a4f4252",
    );
  });
});
