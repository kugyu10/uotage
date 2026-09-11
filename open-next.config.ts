// @opennextjs/cloudflare 用の設定ファイル。
//
// このアプリは全ページが `export const dynamic = "force-dynamic"` で、
// ISR（増分静的再生成）を使っていない（`src/app/**/page.tsx` を参照）。
// そのため R2 / KV を使う incrementalCache（R2 バケット作成が必要 =
// Cloudflareダッシュボード操作になり、このIssueでは禁止）ではなく、
// 追加リソースを必要としない staticAssetsIncrementalCache を使う。
//
// トレードオフ: ISR のオンデマンド再検証は失われるが、そもそも使っていない
// ので実質的な影響はない。将来 ISR を使うページを追加する場合はこの設定を
// 見直すこと（https://opennext.js.org/cloudflare/caching）。
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
