import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this checkout's own tests. `.reference/` holds gitignored review
    // and investigation artifacts that can include whole repo copies, and
    // `.claude/worktrees/` holds other branches' checkouts; without this,
    // vitest sweeps their test files in too, inflating the count and failing
    // on their environment-specific cases.
    exclude: [...configDefaults.exclude, ".reference/**", ".claude/**"],
    // Pin the suite to UTC. Filename assertions are about padding, page
    // suffixes and collision bumps, not timezones — without this they would
    // silently become timezone tests that pass in CI and fail on a dev
    // machine. Local-time behaviour is covered by tests that set TZ themselves.
    env: { TZ: "UTC" },
  },
});
