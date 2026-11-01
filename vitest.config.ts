import { defineConfig } from "vitest/config";

const packages = "{app,factory}/*";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [`${packages}/test/**/*.test.ts`],
          exclude: ["**/node_modules/**", "**/*.live.test.ts"],
        },
      },
      {
        // Real Agent SDK sessions: run only by `pnpm test:live`, never by `pnpm check` or CI.
        test: {
          name: "live",
          include: [`${packages}/test/**/*.live.test.ts`],
          setupFiles: ["./vitest.live-setup.ts"],
          testTimeout: 300_000,
        },
      },
    ],
  },
});
