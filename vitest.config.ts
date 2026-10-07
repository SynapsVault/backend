import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    setupFiles: ["src/test/setupEnv.ts"],
    testTimeout: 10_000,
  },
});
