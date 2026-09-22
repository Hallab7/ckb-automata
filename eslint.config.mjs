import js from "@eslint/js";

export default [
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/target/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
