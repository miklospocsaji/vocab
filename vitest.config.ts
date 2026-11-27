import { defineConfig } from "vitest/config";

// Two projects (change add-app-foundations): `node` for every package but the web app, and
// `web` for the web app's tests in a DOM. `pnpm test` runs both; a run filtered by path,
// such as `vitest run app/`, runs only the matching files of each.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["app/*/test/**/*.test.ts", "infra/test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "app/web/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "web",
          include: ["app/web/test/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**"],
          environment: "happy-dom",
          setupFiles: ["app/web/test/setup.ts"],
        },
      },
    ],
  },
});
