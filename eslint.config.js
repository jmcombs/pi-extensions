import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import security from "eslint-plugin-security";

const TS_GLOBS = ["packages/*/**/*.ts"];

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "packages/_template/**",
    ],
  },

  // TypeScript strict type-checked rules
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: TS_GLOBS,
  })),

  // Stylistic type-checked rules
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: TS_GLOBS,
  })),

  // TypeScript parser options with project-level type information
  {
    files: TS_GLOBS,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Security plugin for Node.js antipatterns
  {
    files: TS_GLOBS,
    plugins: {
      security: security,
    },
    rules: {
      ...security.configs.recommended.rules,
    },
  },

  // Disable formatting rules that conflict with Prettier
  {
    files: TS_GLOBS,
    ...eslintConfigPrettier,
  },

  // Project-wide rule tweaks for extension code
  {
    files: TS_GLOBS,
    rules: {
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
);
