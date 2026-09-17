import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare Workers（移行 #7）: 別ランタイム・別tsconfigのため、
    // Next.js向けESLint設定の対象から外す。
    "workers/**",
  ]),
]);

export default eslintConfig;
