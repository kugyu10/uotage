# 常設指示

- ユーザーへの応答は、常に日本語で行うこと。

## import 規約

- `src/**` の相対importは拡張子を明記する（`./actions.ts` / `./Form.tsx`）。
  規約を1つに統一し、「どこを触っているかで書き方が変わる」状態を解消するため（issue #4）。
  `.ts` の拡張子明記は `node --test --experimental-strip-types` からの直接importにも
  寄与するが、`.tsx` は node の型ストリッピング対象外なので寄与しない（表記統一のみ）。
  `test/import-extension-convention.test.mjs` が機械的に強制する。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
