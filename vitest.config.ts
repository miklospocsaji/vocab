import { defineConfig } from "vitest/config";

const packages = "{app,factory}/*";
const tests = [`${packages}/test/**/*`, "infra/test/**/*"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: tests.map((dir) => `${dir}.test.ts`),
          // The gates' fixture worktrees hold tests of their own, which the gates tests run in a copy.
          exclude: ["**/node_modules/**", "**/*.live.test.ts", "**/*.docker.test.ts", "**/*.container.test.ts", "**/*.cloud.test.ts", "factory/gates/test/fixtures/**"],
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
      {
        // Build and run the worker image: run only by `pnpm test:docker`, never by `pnpm check` or CI.
        test: {
          name: "docker",
          include: [`${packages}/test/**/*.docker.test.ts`],
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        // Against the deployed factory stack with the owner's AWS credentials: run only by
        // `pnpm test:cloud`, never by `pnpm check` or CI. Each one may cost money.
        test: {
          name: "cloud",
          include: tests.map((dir) => `${dir}.cloud.test.ts`),
          testTimeout: 1_200_000,
          hookTimeout: 600_000,
        },
      },
      {
        // Checks that hold only inside the factory-worker image, with real Agent SDK sessions.
        // Run by factory/worker/test/container.live.test.ts in a container, never on the host.
        test: {
          name: "container",
          include: [`${packages}/test/**/*.container.test.ts`],
          testTimeout: 300_000,
        },
      },
    ],
  },
});
