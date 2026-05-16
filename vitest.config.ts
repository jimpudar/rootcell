import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/rootcell/integration/**/*.integration.test.ts"],
          testTimeout: 10_000,
          hookTimeout: 10_000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/rootcell/integration/**/*.integration.test.ts"],
          fileParallelism: false,
          isolate: false,
          testTimeout: 250_000,
          hookTimeout: 250_000,
        },
      },
    ],
  },
});
