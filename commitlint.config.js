export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allow package paths as scopes (e.g., tavily-search, prompt-enhancer)
    "scope-enum": [0],
    // Allow longer headers for descriptive package-scoped messages
    "header-max-length": [2, "always", 100],
  },
};
