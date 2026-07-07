import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    globals: false,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
