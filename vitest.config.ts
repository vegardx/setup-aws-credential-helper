import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
