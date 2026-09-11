# ホスティング移行: Vercel → Cloudflare Workers（`@opennextjs/cloudflare`）

対応 Issue: [kugyu10/uotage#8](https://github.com/kugyu10/uotage/issues/8)
（移行 P2: ホスティングを Vercel から Cloudflare Workers へ）

> **前提（このIssueの作業時点）**: Cloudflare は未契約（アカウントのみ、Workers Paid
> 未契約）。書けるのはコード・設定ファイル・ドキュメントまで。`wrangler deploy` /
> `npx vercel` は一切実行していない。実機の疎通確認・DNS切替・Vercel停止は
> すべて人手作業として UAT 集約Issue（[#13](https://github.com/kugyu10/uotage/issues/13)）
> に送っている。「動くはず」ではなく「未検証」と明記する方針で書く。

## workers/ ディレクトリとの関係（#7 / PR #14 との整理）

[#7](https://github.com/kugyu10/uotage/issues/7)（PR #14、レビュー承認済み・未マージ）は
`workers/dispatch-cron/` に **Cron 起動専用の別 Worker**（`uotage-dispatch-cron`）を
追加する。このIssueが追加する Next.js 本体用 Worker（`uotage-web`、ルート直下の
`wrangler.jsonc` / `open-next.config.ts`）とは、次の理由で衝突しない。

- デプロイ単位が別（`wrangler.jsonc` が2つ、`name` も別: `uotage-dispatch-cron` と
  `uotage-web`）。Cloudflare 上は独立した2つの Worker になる。
- ディレクトリも別（`workers/dispatch-cron/` 配下は独立した npm パッケージで、
  ルートの `tsconfig.json` / `eslint.config.mjs` の対象から明示的に除外されている
  ——このIssueのブランチには `workers/` 自体がまだ無いため、コード上の衝突は無い）。
- ルートの `package.json` にこのIssueで追加した `cf:build` / `cf:preview` /
  `cf:deploy` は Next.js 本体（`uotage-web`）専用。`workers/dispatch-cron` 側の
  `npm run deploy`（`wrangler deploy`）とは別コマンド。

**マージ順序**: どちらを先にマージしても技術的な衝突は無い（触るファイルが
重ならない）。ただし人手作業の依存関係として、

1. 先に #7（PR #14）を運用に載せる方が自然
   （pg_cron → Workers Cron の切替は、配信基盤の可用性に直結し独立して検証しやすい）。
2. このIssue（#8）のホスティング移行は影響範囲が大きい
   （アプリ全体・認証・Server Actions・CSVアップロード）ため、#7 の切替が落ち着いた後に
   進める方が切り分けが楽。

強制ではないが、**#7 → #8 の順に本番切替を進めることを推奨**する。マージ自体（GitHub上の
統合）は順不同で問題ない。

## やったこと

- `@opennextjs/cloudflare@1.20.6` と `wrangler@^4.131.0` を devDependencies に追加
- `next` を `16.3.0` → `16.3.4` に更新
  （`@opennextjs/cloudflare` の `peerDependencies` が `next: ">=15.5.24 <16 || >=16.3.3"` を
  要求するため。16.3.0 は範囲外だった）
- ルートに `open-next.config.ts` / `wrangler.jsonc` を追加
- `package.json` に `cf:build` / `cf:preview` / `cf:deploy` を追加
  （`cf:deploy` は追加しただけで**実行していない**。実行は #13 の人手作業）
- `.gitignore` に `/.open-next/` `/.wrangler/` `.dev.vars` を追加
- `eslint.config.mjs` / `tsconfig.json` に `.open-next` `.wrangler` の除外を追加
  （ビルド生成物を lint/typecheck の対象から外す。無いと `npm run lint` が
  生成物の中身に対して数千件の警告・エラーを出す — 実際に確認済み）

## incrementalCache に R2 / KV を使わなかった理由

`@opennextjs/cloudflare` の既定テンプレートは R2 バケットを使う
`r2-incremental-cache` を使う。しかし R2 バケットの作成は Cloudflare
ダッシュボード/API操作であり、このIssueでは禁止されている。

そこで `src/app/**/page.tsx` を確認したところ、**全ページが
`export const dynamic = "force-dynamic"`** で、ISR（`revalidate` によるオンデマンド
再生成）を使っているページは無かった（`admin/**` の各 Server Action にある
`revalidatePath` 呼び出しは、対象が全て `force-dynamic` ページなので実質的な効果はない）。

このため、追加リソース（R2/KV/Durable Objects）を必要としない
`staticAssetsIncrementalCache` を選んだ（`open-next.config.ts`）。トレードオフは
ISRのオンデマンド再検証を失うことだが、そもそも使っていないので実害はない。
将来 ISR ページを追加する場合はこの設定を見直すこと
（参考: https://opennext.js.org/cloudflare/caching）。

## 重要な発見: Next.js 16 の Proxy は Node.js ランタイムが既定

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`
より:

> Proxy defaults to using the Node.js runtime. The `runtime` config option is not
> available in Proxy files. Setting the `runtime` config option in Proxy will throw
> an error.

つまり **Next.js 16 では `proxy.ts`（旧 middleware）を Edge ランタイムに固定する
選択肢がない**（`runtime` を指定するとビルドエラーになる）。現行の `src/proxy.ts`
はコード自体は Edge 互換（Node API 不使用、`@supabase/ssr` の `createServerClient` の
み）だが、Next.js 16 上では常に Node.js ランタイムとして扱われる。

`npm run cf:build` を実際に実行したところ、次の警告が出た:

```
WARN Node.js middleware support is experimental in cloudflare, and not
officially maintained by OpenNext maintainers. Use at your own risk.
```

ビルド自体は成功し、`.open-next/middleware/handler.mjs` が生成されて Node.js
middleware 用の別バンドルとして動く構成になっている。**ビルドが通ることは確認したが、
Cloudflare Workers 上での実際の動作（Cookie の読み書き・リダイレクト・
`supabase.auth.getClaims()` の呼び出し）は未検証。** OpenNext 側が
「メンテナンス対象外」と明言している機能である点は、#9（認証移行）着手前に
リスクとして共有しておく。UAT（#13）で `/admin` 配下への到達・未認証時の
リダイレクトを実機確認する必要がある。

もし実機で問題が出た場合の代替案:
- `src/proxy.ts` のロジックを Route Handler / layout 側のサーバーコンポーネントに
  移し、Proxy 自体は使わない（Cookieベースのリダイレクトができない場所がある
  ため設計変更が必要になりうる）
- Next.js のマイナーアップデートで Proxy の Edge ランタイム対応が復活するのを待つ

## `headers()` / `experimental.serverActions.bodySizeLimit` の扱い（コード読解、未実機検証）

- `headers()`（`next.config.ts`）: Next.js のリクエストハンドラ自身が付与するレスポンス
  ヘッダーで、OpenNext は Next.js のサーバーコードをそのままバンドルして実行する
  （Cloudflare固有の書き換えをしない）。したがって **Workers上でも同じロジック
  （`next-server` 内の該当処理）がそのまま動くはず**——ただし “動くはず” であり、
  実際に Workers 上でレスポンスヘッダーを確認したわけではない。UATで
  `/`（など任意のページ）に対して `Referrer-Policy` `X-Frame-Options` などが
  ついているかを確認すること。
- `experimental.serverActions.bodySizeLimit: "8mb"`: これも Next.js が Server
  Action のリクエストボディをパースする際に自前で強制する上限で、Cloudflare
  固有の制約ではない。Cloudflare Workers 自体のリクエストボディサイズ上限は
  プラン依存だが一般に 100MB 以上あり、8MBを下回ることはない。コード上は
  問題ないと考えられるが、**実際に5MB前後のCSVをドライラン→確定実行の
  2段階でアップロードして413にならないことは未検証**（要件定義書 10.2 の
  「事故防止が最重要」領域そのものなので、UATで最優先に確認してほしい）。

## バンドルサイズ（実測、ただし近似値）

`npm run cf:build`（= `opennextjs-cloudflare build`）を実行し、`.open-next/`
配下に生成された各ファイルの gzip サイズを実測した（Cloudflare Workers の
上限は圧縮後 10 MiB／Bundled Worker）。

| ファイル | 生サイズ | gzip |
|---|---:|---:|
| `worker.js` | 2.3 KB | 0.7 KB |
| `middleware/handler.mjs`（Node.js middleware バンドル） | 3.1 MB | 663 KB |
| `server-functions/default/handler.mjs`（Next.jsサーバー本体） | 5.7 MB | 1.37 MB |
| `cloudflare/images.js` | 19.5 KB | 4.5 KB |
| `cloudflare/init.js` | 2.5 KB | 1.1 KB |
| `cloudflare/skew-protection.js` | 1.4 KB | 0.6 KB |
| `.build/durable-objects/*.js`（3ファイル） | 22 KB | 7 KB |
| **合計（単純合算）** | **約 8.9 MB** | **約 2.03 MiB** |

10 MiB 上限に対して約 20% の使用率で、余裕がある。

**ただし、これは `wrangler deploy` が最終的に行う esbuild バンドル・
圧縮の結果ではない**（`wrangler deploy` の実行自体がこのIssueで禁止されている
ため、実行していない）。上表は OpenNext のビルド出力を個別に gzip した単純合算値で、
実際の Workers アップロード用バンドルは複数ファイルを1本にまとめてから圧縮するため
（重複コードの共有辞書効果で）**この合算値より小さくなる可能性が高い**。逆に
`server-functions/default/node_modules/` 配下（`react` `react-dom` `next`
`@swc` など）がまだバンドルに含まれていない依存として残っており、最終バンドルに
含まれるかどうかは `wrangler deploy` を実行するまで確定しない。したがって
**「10 MiB に収まる可能性が高いが、最終確認は実デプロイ時」** というのが正直な結論。
UAT（#13）で `wrangler deploy` 実行時に出力される最終バンドルサイズを確認すること。

## 環境変数の移行方針

### 現状（Vercel）

`scripts/sync-vercel-production-env.mjs` が `vercel env add <name> production`
を1件ずつ実行して Vercel Production 環境変数を同期している。

### Cloudflare Workers での対応

Cloudflare Workers の環境変数は2種類に分かれる。

- **`vars`**（`wrangler.jsonc` の `vars` フィールド、平文）: 秘密情報ではない値向け。
  リポジトリにコミットされる `wrangler.jsonc` に直接書くべきではない値
  （このアプリは `NEXT_PUBLIC_*` も含めほぼ全てが秘密情報かテナント固有情報なので、
  `vars` に書いてよい値は実質無いと判断した）。
- **Secrets**（`wrangler secret put <name>`、暗号化保管）: 秘密鍵・トークン類。
  対話的に1件ずつ設定する（`workers/dispatch-cron/README.md` の
  `CRON_SECRET` 設定と同じ方式）。

`src/lib/env.ts` の `publicEnv` / `serverEnv` が参照する環境変数は次の通り
（`NEXT_PUBLIC_*` も含め、Cloudflare 側では区別なくすべて Secrets 経由で渡す
方針とする——ブラウザに露出させたい `NEXT_PUBLIC_*` はビルド時に Next.js が
埋め込むため、実際には **ビルド時**にも同じ値が必要になる点に注意。ローカルの
`.env.local` を `cf:build` 実行前に用意しておく必要がある）。

```
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_OPERATOR_NAME
NEXT_PUBLIC_CONTACT_EMAIL
NEXT_PUBLIC_OPERATOR_ADDRESS
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
NEXT_PUBLIC_BOOKING_URL
SUPABASE_SERVICE_ROLE_KEY
DEFAULT_TENANT_ID
RESEND_API_KEY
RESEND_FROM_EMAIL
RESEND_FROM_NAME
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

（`RESEND_PROBE_API_KEY` はローカル `npm run probe` 専用、本番には設定しない —
既存の `sync-vercel-production-env.mjs` のコメントと同じ方針を踏襲）

### `scripts/sync-vercel-production-env.mjs` の後継

このスクリプトは削除せず残す（Vercelでの並行稼働中は引き続き必要）。
後継として `scripts/sync-cloudflare-worker-secrets.mjs`（未実装、**このIssueでは
書いていない**）を新規に用意する方針を提案する。理由: 実装しても
`wrangler secret put` を実行する時点で Cloudflare API と通信するため、
このIssueの「外部サービスへの副作用を起こさない」制約に抵触する。
スクリプトの雛形すら「実行しないと動作確認できない」性質のものなので、
**実装は Cloudflare Workers Paid 契約後、実際に1回手動で `wrangler secret put`
を回してみてから書く方が安全**と判断した（先に自動化を書いて、いざ実行したら
`wrangler secret put` の対話プロンプトの挙動が違って全部やり直し、という事故を
避ける）。UAT（#13）に、初回は手動で `wrangler secret put` を回すこと、
2回目以降のローテーション用に自動化スクリプトを書くかどうかの判断を委ねる。

## 並行稼働 → DNS切り替え → Vercel停止 の手順（人手作業。#13へ）

**この節はすべて未実行の手順書。実行は #13 で追跡する。**

### 1. 並行稼働（Cloudflare Workers を「隠しURL」で立てる）

1. Cloudflare Workers Paid（$5/月）を契約する
2. `npm ci && npm run cf:build`
3. `.dev.vars` または `wrangler secret put` で Secrets を設定する
   （上記「環境変数の移行方針」参照）
4. `npx wrangler deploy`
   → `<worker名>.<アカウント名>.workers.dev` のURLが払い出される
   （本番ドメインにはまだ紐付けない）
5. `workers.dev` のURLに対して手動で一通り動作確認する
   （ログイン、`/admin` 配下、CSVインポートのドライラン→確定実行、
   Stripe決済のテストモード、メール配信のトリガ）。
   **このステップで「Node.js middleware警告」「headers()」
   「bodySizeLimit 8MB」の3点を重点的に見る**（上記「未検証」項目）。

### 2. DNSを切り替える

6. 問題が無ければ、Cloudflareダッシュボードの Workers Routes（または
   カスタムドメイン機能）で本番ドメインをこの Worker に向ける。
   **DNSレコードの変更を伴う。このIssueの担当は実行しない。**
7. 切替直後は Vercel 側のデプロイも生かしたまま
   （Vercel側のプロジェクトは止めない）、本番ドメインでの実トラフィックを
   Cloudflare Workers 側のログ・エラー率で監視する
   （Cloudflareダッシュボードの Workers Logs、`wrangler tail`）。
8. Stripe Webhook のエンドポイントURLは変わらない想定
   （ドメインは同じ、パスも `/api/stripe/webhook` のまま）だが、
   実際にWebhookイベントが届いていることを Stripe Dashboard の
   Webhook配信ログで確認する。

### 3. Vercelを停止する

9. 上記の監視期間（最低数日を推奨。既存の `deliveries` 配信サイクルが
   1周〜数周する期間は見ること）で問題が無いことを確認したら、
   Vercelプロジェクトの本番デプロイを無効化する（プロジェクト自体の削除は
   しなくてよい。ロールバック手段として残す）。
10. `scripts/sync-vercel-production-env.mjs` は当面残す
    （ロールバック時に Vercel へ再デプロイする可能性があるため）。
    完全に不要と判断できたら別Issueで削除を検討する。

### ロールバック

Cloudflare Workers 側に問題が出た場合、DNS/Workers Routes を Vercel 側の
ドメイン設定に戻すだけで良い（Vercel側は停止するまで動かし続けている前提）。
Vercelを先に停止してしまっていた場合は、`vercel --prod` で再デプロイしてから
DNSを戻す。

## 検証結果（このIssueの担当が実行したもの）

- `npm run build`（Next.js 通常ビルド、next 16.3.4）: 成功
- `npm run cf:build`（`opennextjs-cloudflare build`）: 成功
  （Node.js middleware 警告あり、上記参照）
- `npm run lint`: 成功（`.open-next` 除外を追加後）
- `npm run typecheck`: 成功
- `npm run test`: 191件中190件成功、1件失敗
  （`test/import-export-limits.test.mjs` の
  `行数ガードの migration は既存の最新より後のバージョンになっている` ——
  **このIssueの変更を一切適用していない `origin/main` でも同じ1件が失敗することを
  `git stash` で確認済み**。既存の不具合でこのIssueのスコープ外のため、
  修正はせずそのまま報告する）

## 未検証（Cloudflareアカウントの状態・実デプロイに依存するため、UAT #13へ）

- `wrangler deploy` による実デプロイと、その際の最終バンドルサイズ
- Cloudflare Workers 上での `/admin` 認証フロー（Node.js middleware 経由の
  Cookie読み書き・リダイレクト）
- `headers()` が実際に Workers上のレスポンスに付与されること
- Server Action の `bodySizeLimit: "8mb"` が Workers上でも8MBまで通ること
  （CSVインポートのドライラン→確定実行）
- Stripe Webhook・Resendメール送信・Supabase接続の実疎通
- DNS切替・Vercel停止・ロールバック手順そのものの実行
