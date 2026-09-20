// @opennextjs/cloudflare 用の設定ファイル。
//
// このアプリの src/app/**/page.tsx（29ファイル）のうち、24ページは
// `export const dynamic = "force-dynamic"`。残り5ページ
// （`/`, `/login`, `/privacy`, `/offer-ended`, `/purchase-complete`）は
// dynamic指定が無く、ビルド時にプリレンダされる純静的ページ。
// いずれのページも `revalidate` によるISR（増分静的再生成）は使っていない
// （grep済み。プリレンダされる5ページも一度生成したら再検証しない）。
// そのため R2 / KV を使う incrementalCache（R2 バケット作成が必要 =
// Cloudflareダッシュボード操作になり、このIssueでは禁止）ではなく、
// 追加リソースを必要としない staticAssetsIncrementalCache を使う。
//
// トレードオフ: ISR のオンデマンド再検証は失われるが、そもそも使っていない
// ので実質的な影響はない。将来 ISR を使うページを追加する場合はこの設定を
// 見直すこと（https://opennext.js.org/cloudflare/caching）。
//
// 注意: プリレンダされる5ページ（特に /login と /privacy）は
// `NEXT_PUBLIC_*` をビルド時の値のまま焼き込む。詳細は
// docs/cloudflare-workers-hosting.md の
// 「ビルド時に焼き込まれる値と、実行時に読まれる値の違い」を参照。
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// enableCacheInterception はあえて指定していない（既定 false のまま）。
// 既定 true にすると `dangerous.enableCacheInterception` が有効になり、
// 全リクエストで ASSETS.fetch() 経由のキャッシュ参照が1本増える
// （node_modules/@opennextjs/cloudflare/dist/api/config.js:9,27-29）。
// このアプリは全ページが force-dynamic かプリレンダの純静的ページのみで、
// `.open-next/assets/cdn-cgi/_next_cache/` も生成されない
// （static-assets-incremental-cache.js が読むパスが実在しないことを確認済み）。
// つまり有効化しても得が無く、全リクエストで必ず失敗する
// サブリクエストが1本増えるだけなので、既定のfalseのままにしている。
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
