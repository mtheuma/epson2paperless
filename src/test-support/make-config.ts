// src/test-support/make-config.ts
//
// Shared test Config factory. It runs the real Zod schema, so every field
// takes the schema's own default and a new Config field never needs a test
// edit; only the values the tests assert on are pinned here.

import { configSchema, type Config } from "../config.js";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return configSchema.parse({
    printerIp: "192.0.2.5",
    outputDir: "/test-output",
    scanResolution: 200,
    ...overrides,
  });
}
