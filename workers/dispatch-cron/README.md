# uotage-dispatch-cron

Cloudflare Workers の Cron Trigger（1分間隔）から、既存の Supabase Edge Function
`dispatch-deliveries` を呼び出すだけの薄い Worker。

対応 Issue: [kugyu10/uotage#7](https://github.com/kugyu10/uotage/issues/7)
（移行 P1: Cron を Supabase pg_cron から Cloudflare Workers Cron Triggers へ）

DB・アプリコードには一切触れない。呼び出し方（POST + `Authorization: Bearer
<CRON_SECRET>`）は現行の pg_cron 経路
（`supabase/migrations/20260817010000_configure_delivery_cron.sql`）と同じ。

> **未検証（このIssueの作業時点）**: Cloudflare は未契約（アカウントのみ、
> Workers Paid 未契約）のため、実際の `wrangler deploy` / Cron Trigger の起動
> 確認は行っていない。ここに書く手順・コードはローカルの静的検証（型・構文）
> のみ通した状態。実機での疎通確認は UAT 集約Issue（#13）へ委ねる。

## 構成

```
workers/dispatch-cron/
  wrangler.jsonc   # crons: ["* * * * *"]
  src/index.ts     # scheduledハンドラ本体
  package.json     # このディレクトリ単体のnpmパッケージ（ルートpackage.jsonとは独立）
  tsconfig.json    # Cloudflare Workers用の型（@cloudflare/workers-types）
```

ルートの `next build` / `tsc` / `eslint` の対象からは明示的に除外している
（`tsconfig.json` の `exclude`、`eslint.config.mjs` の `globalIgnores`）。
Next.js アプリ（Vercelでホスト、#8で移行予定）とは完全に独立したデプロイ単位。

## 必要なシークレット（Workers Secrets）

値はコード・設定ファイル・ドキュメントのどこにも書かない。`wrangler secret put`
で対話的に設定する（このコマンド自体はローカルで完結するが、Cloudflareの
API/ダッシュボードと通信するため、Workers Paid契約後に実施すること）。

```sh
cd workers/dispatch-cron
npx wrangler secret put SUPABASE_PROJECT_URL
# 例: https://xxxxxxxx.supabase.co （末尾スラッシュなし）

npx wrangler secret put CRON_SECRET
# 現行 Vault の `cron_secret` と同じ値を使う（切替時。ローテーションする場合は
# Edge Function側のCRON_SECRETも同時に更新すること）
```

`CRON_SECRET` の現在値は Supabase Vault（`vault.decrypted_secrets` の
`cron_secret`）にある。本Issueの担当はSupabase本番へ接続できないため、値の
取得・投入は人手作業（#13）。

## ローカル検証（アカウント不要な範囲）

```sh
cd workers/dispatch-cron
npm install          # 未実施（ネットワーク・アカウント状態に依存するため）
npm run typecheck    # tsc --noEmit
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

`wrangler dev` はローカルのモックSecretsが必要（`.dev.vars`。gitignore対象、
リポジトリには含めない）。**このIssueの作業では `npm install` と
`wrangler dev` 実測は行っていない（未検証）。** Cloudflareアカウントの
状態に依存するため、通らなくても本Issueの失敗とはしない。

`.dev.vars` の例（コミットしないこと）:

```
SUPABASE_PROJECT_URL=https://xxxxxxxx.supabase.co
CRON_SECRET=<ローカル検証用のダミー値>
```

## デプロイ手順（人手作業。#13へ）

1. Cloudflare Workers Paid（$5/月）を契約する
2. `cd workers/dispatch-cron && npm install`
3. 上記の `wrangler secret put` でシークレットを設定
4. `npx wrangler deploy`
5. Cloudflareダッシュボードの Cron Triggers → Past Events で1分間隔の起動を確認

## 切替手順（二重起動を作らない順序）

Issue本文の注意点のとおり、**pg_cronを先に止めてから Workers を有効化する**。
逆順（Workers先行 → pg_cron停止）だと、両方が同時に `dispatch-deliveries` を
叩く期間ができる。`claim_deliveries` の `FOR UPDATE SKIP LOCKED` と
`UNIQUE(scenario_reader_id, step_message_id)` があるため二重送信という致命傷
にはならない設計だが、切り分けを容易にするため重複期間そのものを作らない。

1. **pg_cronを停止する**（Supabase SQL Editor、`service_role`相当の実行権限で）

   ```sql
   select cron.unschedule(
     (select jobid from cron.job where jobname = 'dispatch-deliveries-every-minute')
   );
   ```

   停止できたことを確認:

   ```sql
   select jobid, jobname, schedule, active
   from cron.job
   where jobname = 'dispatch-deliveries-every-minute';
   -- 0行になっていればOK
   ```

2. 上記「デプロイ手順」でWorkerをデプロイし、Cron Triggerを有効化する
3. Cloudflareダッシュボード（Cron Triggers → Past Events）で1分間隔の起動が
   継続していることを確認する
4. `deliveries` テーブルで `sent_at` の間隔が1分前後で継続していることを確認する
   （本番DBへの参照のみ。書き込みはしない）

   ```sql
   select delivery_id, sent_at
   from public.deliveries
   where sent_at is not null
   order by sent_at desc
   limit 20;
   ```

5. 上記が確認できたら、Vault の `project_url` / `cron_secret` シークレットを
   削除する（`configure_delivery_cron` への依存を断つ）

   ```sql
   select vault.delete_secret(id) from vault.secrets where name in ('project_url', 'cron_secret');
   ```

   ※ Workers側の `CRON_SECRET` はこれとは別にWorkers Secretsとして保持して
   いるため、Vault側を削除してもWorkerの動作には影響しない。

上記1〜5はすべて **人手作業**。このIssueの担当はSupabase本番・Cloudflare
ダッシュボードのいずれにも実行権限がないため、実行していない。手順として
残すのみ。実施と結果確認は #13 で追跡する。

## ロールバック手順

Workers側に問題が起きた場合、pg_cron経路へ緊急で戻す手順:

1. Cloudflareダッシュボード、またはWorkerの設定（`wrangler.jsonc` の
   `triggers.crons` を空にして再デプロイ）でCron Triggerを無効化する
2. `supabase/cron/dispatch-deliveries.sql` の手順に従って
   `configure_delivery_cron` を再実行し、pg_cronを再構成する
   （`npm run deliveries:deploy -- --app-url <...> --confirm --configure-pg-cron`）
3. pg_cronの起動を確認してから、Workers側が完全に停止していることを再確認する
   （手順1と3の順序が逆になると二重起動になる）

## 既存資産の扱い

- `supabase/cron/dispatch-deliveries.sql`: 削除せず、**ロールバック専用**の
  手順として残した（ファイル先頭に非推奨コメントを追加済み）
- `scripts/deploy-delivery-worker.mjs`: 削除せず、Edge Function
  `dispatch-deliveries` 自体のデプロイ・secrets設定には引き続き使う
  （Cron起動元がWorkersに変わっても、Edge Function自体は必要）。
  pg_cronの(再)構成部分は `--configure-pg-cron` を明示しない限り実行しない
  よう変更した（既定でスキップ）。理由: このスクリプトを
  Edge Functionの再デプロイ目的で実行するたびにpg_cronが復活し、Workersと
  二重起動する事故を防ぐため
- `supabase/migrations/20260817010000_configure_delivery_cron.sql`:
  マイグレーション履歴は書き換えない。`configure_delivery_cron` 関数自体は
  ロールバック経路で使うため残す
