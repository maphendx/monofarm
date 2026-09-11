import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Intentional "reset/sync form state when a modal opens" pattern
      // (useEffect(() => { if (!open) return; setX(...) }, [open])). The Next 16
      // React-Compiler rule flags it, but it is correct here. Tracked as a
      // warning; modals are being migrated to key-based remount incrementally
      // (CloseBatch, CreateBatch, Movement, LabelGenerator, TelegramLink done).
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/BrowserPrint.min.js",
  ]),
]);

export default eslintConfig;
