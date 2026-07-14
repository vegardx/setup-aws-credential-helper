import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 85, functions: 80, branches: 75, statements: 80 },
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
