import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    // ESLint looks up the config per file, so an agent worktree under .claude/
    // would be linted with its own config and its own typed project service.
    // Skip those trees and the skill copies, as knip.json does.
    ignores: ["**/coverage/**", "**/dist/**", "**/.claude/**", ".agents/**"],
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.steps.ts", "**/dist/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Only enable the unsafe type assertion rule — Biome handles everything else
      "@typescript-eslint/no-unsafe-type-assertion": "error",
    },
  },
];
