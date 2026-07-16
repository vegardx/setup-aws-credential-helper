import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __TEST_ALLOW_LOCAL_HTTP__: "false" },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 85, functions: 80, branches: 75, statements: 80 },
      exclude: ["tests/**"],
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
