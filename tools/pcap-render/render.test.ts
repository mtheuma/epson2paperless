import { describe, it, expect } from "vitest";
import { parseRenderArgs } from "./render.js";

describe("parseRenderArgs", () => {
  it("parses positionals plus --stream/--width/--height flags", () => {
    const args = parseRenderArgs([
      "cap.pcap",
      "flatbed",
      "jpg",
      "/out",
      "--stream",
      "1",
      "--width",
      "2481",
      "--height",
      "3507",
    ]);
    expect(args).toEqual({
      pcapPath: "cap.pcap",
      source: "flatbed",
      format: "jpg",
      outputDir: "/out",
      tcpStream: 1,
      widthPx: 2481,
      heightPx: 3507,
    });
  });

  it("leaves the flags undefined when absent", () => {
    const args = parseRenderArgs(["cap.pcap", "flatbed", "jpg", "/out"]);
    expect(args).toEqual({
      pcapPath: "cap.pcap",
      source: "flatbed",
      format: "jpg",
      outputDir: "/out",
      tcpStream: undefined,
      widthPx: undefined,
      heightPx: undefined,
    });
  });
});
