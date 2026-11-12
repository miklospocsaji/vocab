import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The gates' fixture worktrees are broken on purpose in places; the gates tests lint them in a copy.
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/", "**/cdk.out/", ".claude/", "openspec/", "factory/gates/test/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  // Agent-written app code: an unused parameter or variable named `_x` is deliberate, as in
  // the test author's stubs (add-build-roles). Factory code keeps the default rule.
  {
    files: ["app/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
);
