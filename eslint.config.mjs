import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

const appFiles = [
  "apps/sticker-market/**/*.{js,jsx,ts,tsx}",
  "apps/usa-christmas-supplements/**/*.{js,jsx,ts,tsx}",
];

export default [
  { ignores: ["**/.next/**", "**/node_modules/**", "apps/**/lib/generated/**"] },
  {
    files: appFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { ...js.configs.recommended.rules, "no-unused-vars": "off" },
  },
  {
    files: ["apps/**/*.ts", "apps/**/*.tsx"],
    languageOptions: { parser: tsParser },
  },
  {
    files: ["apps/sticker-market/app/actions.js"],
    rules: { "preserve-caught-error": "off" },
  },
];
