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

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*", "expo-env.d.ts"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { paths: [textInputPath] }],
    },
  },
  {
    // The one place allowed to wrap TextInput.
    files: ["src/components/ui/TextField.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
]);
