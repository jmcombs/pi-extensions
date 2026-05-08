import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import security from "eslint-plugin-security";

// Lint every package's TypeScript except the scaffold; new packages are picked
// up automatically. `_template/` is excluded via `ignores` below so following
// TEMPLATE.md "just works" without touching this file.
const TS_GLOBS = ["packages/*/**/*.ts"];

export default defineConfig([
  // Global ignores — replaces .eslintignore. Must be a config object with only `ignores`.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "packages/_template/**",
    ],
  },

  // Type-aware linting for every controlled package.
  {
    files: TS_GLOBS,
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      // eslint-config-prettier must come last to disable conflicting stylistic rules.
      eslintConfigPrettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      security,
    },
    rules: {
      ...security.configs.recommended.rules,
      // Honor the `_`-prefix convention for intentionally unused params/vars.
      // Pi extension callbacks (execute, event handlers) often have unused
      // trailing parameters that we still want to spell out for documentation.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  // Safety net: disable type-aware linting for any TS files inside node_modules
  // that the project graph might otherwise pull in.
  {
    files: ["**/node_modules/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
