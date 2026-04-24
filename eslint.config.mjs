import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".reference/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow `_`-prefixed unused args/vars (common convention for intentional ignores).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Protocol code deals with raw bytes; `any` appears in some buffer
      // manipulation where the shape is known from the wire format.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Test files + test-support: relax strictness that fights fixtures and
    // fire-and-forget async patterns common in test setup.
    files: ["**/*.test.ts", "src/test-support/**/*.ts", "tools/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    // Tools/ scripts are dev-only utilities — relax unsafe-* rules around
    // JSON.parse and similar dynamic shapes.
    files: ["tools/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    // Plain-JS scripts don't have a tsconfig; skip type-aware linting for them.
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Frida agent runs inside the Frida runtime, not Node. Its globals
    // (send, recv, Interceptor, Process, Memory, etc.) are provided by
    // the Frida VM and aren't resolvable as Node modules. The file also
    // lives outside tsconfig.eslint.json's project graph, so type-aware
    // parsing is disabled via `project: null`.
    files: ["tools/frida-capture/agent.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        project: null,
      },
      globals: {
        send: "readonly",
        recv: "readonly",
        Interceptor: "readonly",
        Process: "readonly",
        Module: "readonly",
        Memory: "readonly",
        NativePointer: "readonly",
        ptr: "readonly",
      },
    },
  },
  prettier,
);
