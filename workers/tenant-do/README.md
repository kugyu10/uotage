# uotage-tenant-do

issue #29 [移行 P5] ADR 方式A（`docs/移行P5-ADR-トランザクション設計.md`）: テナント単位で
書き込みを直列化する Durable Object。`register_reader` / `process_stripe_purchase` /
`import_scenario_readers`（Postgres の PL/pgSQL 関数3本）に相当する書き込みをこの DO
経由にすることで、DO のシングルスレッド実行モデルで Postgres の `FOR UPDATE` 相当の
排他を代替する。

対応 Issue: [kugyu10/uotage#29](https://github.com/kugyu10/uotage/issues/29)

> **このIssueで実装済みなのは `TenantDurableObject.processStripePurchase` のみ。**
> `register_reader` / `import_scenario_readers` 用のRPCメソッドは未実装（#29 の残タスク）。
> ルート側 `wrangler.jsonc` からのクロスワーカーバインディング（`script_name`）だけを
> 先に敷いてある。

> **直列化の実装**: DO の input/output gate は `ctx.storage` への操作しか自動で守らない
> （D1 バインディングへの fetch は対象外。Cloudflare公式ドキュメントで確定）。そのため
> 各 RPC メソッドは `ctx.blockConcurrencyWhile()` で処理全体を囲んで直列化している
> （`src/index.ts` の `TenantDurableObject.processStripePurchase` 参照）。

> **未検証（このIssueの作業時点）**: Cloudflare は未契約（アカウントのみ）のため、実際の
> `wrangler deploy` / D1 データベース作成 (`wrangler d1 create`) / DO の実機起動は行っていない。
> ローカルでは `npm install` / `npm run typecheck` / `npx wrangler deploy --dry-run`
> （バンドル・バインディング解決まで）を確認済み。実機の確認は UAT 集約Issue（#13）へ委ねる。
> `wrangler.jsonc` の `database_id` はプレースホルダ（`REPLACE_WITH_REAL_D1_DATABASE_ID`）
> のままなので、実インフラ作成後に差し替えること。

## 構成

```
workers/tenant-do/
  wrangler.jsonc   # d1_databases (DB) + durable_objects migrations (このワーカーがクラスを定義する側)
  src/index.ts      # TenantDurableObject 本体 + D1Executor アダプタ
  package.json      # このディレクトリ単体のnpmパッケージ（ルートpackage.jsonとは独立）
  tsconfig.json      # Cloudflare Workers用の型（@cloudflare/workers-types）
```

ルートの `next build` / `tsc` / `eslint` の対象からは明示的に除外している
（ルート `tsconfig.json` の `exclude`、`eslint.config.mjs` の `globalIgnores` — いずれも
`workers/dispatch-cron` と同じ扱い）。ただし `src/index.ts` は `../../../src/lib/d1/tenant-db.ts`
と `../../../src/lib/purchases/process-stripe-purchase.ts` をそのまま import している
（テナント境界の強制ロジックと、移植した業務ロジックを重複実装しないため）。この2ファイルは
ルート側の `npm run typecheck` / `npm test` でも検証される。

## なぜ別ワーカーか

`uotage-web`（ルートの `wrangler.jsonc`）の `main` は `@opennextjs/cloudflare` が
ビルド時に生成する `.open-next/worker.js` で、Durable Object クラスを手で追記できない
（ビルド成果物のため）。Cloudflare の Durable Objects はクラスを export するワーカーと、
それを使うワーカーが別で構わない（`durable_objects.bindings[].script_name` によるクロス
ワーカー参照）ため、DO 専用の小さいワーカーを切り出した。`workers/dispatch-cron` と
同じ「Next.js アプリとは別デプロイ単位」というこのリポジトリの既存パターンに沿っている。

## 必要なリソース（Cloudflare側での作成が必要。このIssueでは未実施）

```sh
# D1データベース本体の作成（database_id が発行される）
npx wrangler d1 create uotage-db
# ↑ で出力される database_id を、このワーカーとルートの wrangler.jsonc 両方の
#   "database_id": "REPLACE_WITH_REAL_D1_DATABASE_ID" に反映する。

# マイグレーション適用（cloudflare/d1/migrations/ 配下）
npx wrangler d1 migrations apply uotage-db --remote
```

## ローカル検証

```sh
cd workers/tenant-do
npm install
npm run typecheck
npx wrangler versions upload --dry-run   # バンドル・バインディング解決まで確認（デプロイはしない）
```
