import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "**/cdk.out/", ".claude/", "openspec/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // An unused parameter or variable named `_x` is deliberate, as in the stub of a source file
  // written before its implementation.
  {
    files: ["app/**/*.{ts,tsx}", "infra/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // The web app runs in the browser and uses React hooks (change add-app-foundations).
  {
    files: ["app/web/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: globals.browser },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
