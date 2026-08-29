import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pin the suite to UTC. Filename assertions are about padding, page
    // suffixes and collision bumps, not timezones — without this they would
    // silently become timezone tests that pass in CI and fail on a dev
    // machine. Local-time behaviour is covered by tests that set TZ themselves.
    env: { TZ: "UTC" },
  },
});
