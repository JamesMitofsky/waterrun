// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

// Every text input goes through TextField, whose Return key always closes the
// keyboard; a bare TextInput can leave the user with no way to dismiss it.
const textInputPath = {
  name: "react-native",
  importNames: ["TextInput"],
  allowTypeImports: true,
  message: "Use TextField from src/components/ui/TextField so Return closes the keyboard.",
};

// Metro doesn't tree-shake, so the package root (an `export *` of all 1,512
// icons, each building six weights of SVG at load) put ~5.6 MB into the bundle
// and ran on every cold start. Per-icon files pull in only what's used.
const phosphorPath = {
  name: "phosphor-react-native",
  allowTypeImports: true,
  message: 'Import each icon from "phosphor-react-native/src/icons/<Name>".',
};

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "expo-env.d.ts"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { paths: [textInputPath, phosphorPath] },
      ],
    },
  },
  {
    // The one place allowed to wrap TextInput.
    files: ["src/components/ui/TextField.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [phosphorPath] }],
    },
  },
]);
