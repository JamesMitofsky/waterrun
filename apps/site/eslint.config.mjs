import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import astro from "eslint-plugin-astro";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
  { ignores: ["dist/", ".astro/", ".vercel/", "node_modules/"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  ...astro.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: { parser: ts.parser },
    },
    rules: {
      // Bare `state; // track` reads are Svelte's idiom for declaring an $effect's
      // reactive dependencies — not dead expressions.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    rules: {
      // TypeScript resolves ambient globals (e.g. the GeoJSON namespace); no-undef
      // only sees the untyped identifier and false-positives.
      "no-undef": "off",
      // Frozen demo route data uses throwaway loop bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // phosphor-svelte's index re-exports every icon and declares no
      // `sideEffects`, so the bundler keeps it as one shared module: every icon
      // any island imports, with all six weights each, lands in a single chunk
      // that every one of those islands then downloads.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "phosphor-svelte",
              message:
                'Import each icon from its own file, e.g. `import HouseIcon from "phosphor-svelte/lib/HouseIcon"`; the barrel bundles every icon on the site into one chunk.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
