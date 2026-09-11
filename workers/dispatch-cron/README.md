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
> 確認は行っていない。ローカルでは `npm install` / `npm run typecheck` /
> `wrangler dev --test-scheduled` によるハンドラ起動まで確認済み（詳細は
> 「ローカル検証」節）。実機（Cloudflareデプロイ・実Supabaseへの疎通・
> pg_cron停止）の確認は UAT 集約Issue（#13）へ委ねる。

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
# 現行 Vault の `cron_secret` と同じ値を使う（切替時）。
```

`CRON_SECRET` の現在値は Supabase Vault（`vault.decrypted_secrets` の
`cron_secret`）にある。Supabase SQL Editor で以下を実行すると値が画面に
表示される（`service_role` 相当の実行権限が必要。値はコピー後、SQL Editor
の実行結果を残さないこと＝タブを閉じる/クエリ結果をクリアする）。

```sql
select decrypted_secret
from vault.decrypted_secrets
where name = 'cron_secret';
```

本Issueの担当はSupabase本番へ接続できないため、値の取得・
`wrangler secret put CRON_SECRET` への投入は人手作業（#13）。

### CRON_SECRETをローテーションする場合（任意）

`scripts/deploy-delivery-worker.mjs` は **既定では CRON_SECRET を一切
変更しない**（Edge Functionの再デプロイのみ）。ローテーションしたい場合は
明示的に次のいずれかを指定する（レビュー指摘 #7 🔴-1 対応。詳細は
「既存資産の扱い」を参照）。

- `--cron-secret <value>`: 自分で選んだ値を使う。この値をそのまま
  `wrangler secret put CRON_SECRET` にも入力すれば、両者は必ず一致する
- `--rotate-cron-secret --secret-out <path>`: ランダムな値を生成し、
  指定したパス（権限0600）に書き出す。書き出したファイルを読んで
  `wrangler secret put CRON_SECRET` に入力したら、ファイルは削除する

どちらも指定せず `--rotate-cron-secret` だけを付けるとスクリプトはエラーで
停止する（値を運用者が取得できないまま Workers 側と食い違うのを防ぐため）。

## ローカル検証（アカウント不要な範囲）

```sh
cd workers/dispatch-cron
npm install          # 確認済み
npm run typecheck    # tsc --noEmit — 確認済み
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json"
```

`wrangler dev` はローカルのモックSecretsが必要（`.dev.vars`。gitignore対象、
リポジトリには含めない）。

### 確認済み（本Issueの作業で実際に実行した）

- `npm install`（型定義パッケージ `@cloudflare/workers-types` の実在バージョンも
  `npm view` で確認したうえでインストールできることを確認）
- `npm run typecheck`（`tsc --noEmit` が成功）
- `npx wrangler dev --test-scheduled` でのローカル起動
- `.dev.vars` にダミー値（存在しない `*.supabase.co` サブドメイン）を設定した状態で
  `curl "http://localhost:<port>/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json"`
  を実行し、scheduledハンドラが起動すること、fetchが失敗してもプロセスが
  クラッシュせず `console.error` でログを残して終了することを確認
  （検証後 `.dev.vars` は削除済み。gitignore対象で元々コミットされない）

### 未確認（Cloudflareアカウントの状態・本番接続に依存するため）

- `wrangler deploy` による実デプロイ（Cloudflare Workers Paid 未契約）
- Cloudflare Cron Trigger の実際の1分間隔起動
- 実在の Supabase Edge Function `dispatch-deliveries` への疎通
  （`Authorization` ヘッダの検証が通ること・200が返ること）
- pg_cron の停止

これらは通らなくても本Issueの完了条件を満たさないわけではないが、
切替前に UAT 集約Issue（#13）で人手により確認する。

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
   する。**ただし、これは Worker自体が起動したことしか示さない。**
   `dispatch-deliveries` Edge Function への呼び出しが実際に成功したか
   （401・5xxで失敗していないか）は Past Events だけではわからない。
   Workers Logs（`wrangler tail` またはダッシュボードの Logs）で
   `dispatch-deliveries ok: ...` のログが出ていること、`dispatch-deliveries failed: ...`
   や `dispatch-deliveries request error: ...` が出ていないことを必ず併せて確認する
   （#7 レビュー指摘 🟡-1。非2xx・例外時は now throw するため、失敗時は
   Past Events 側にも invocation失敗として記録される）

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
   継続していることを確認する。**繰り返しになるが、これだけでは配信が
   実際に行われたかはわからない。** Workers Logs で `dispatch-deliveries ok`
   のログが継続して出ていることも必ず確認する（デプロイ手順:5 参照）
4. `deliveries` テーブルで `sent_at` の間隔が1分前後で継続していることを確認する
   （本番DBへの参照のみ。書き込みはしない）。切替当日だけでなく、
   **切替後しばらくは継続的に見ること**（Workers Logsだけでは
   「呼び出しに成功した」ことしかわからず、Edge Function内部の
   個別配信の成否まではわからないため）

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

1. **Cloudflareダッシュボードから Cron Trigger を削除する**（第一手段。
   Workers → 対象Worker → Triggers → Cron Triggers から削除）。
   `wrangler.jsonc` の `triggers.crons` を空にして再デプロイする方法は、
   実際に既存のCron Triggerが解除されるか本Issueでは未確認のため、
   緊急時は確実なダッシュボード側の削除を優先すること（#7 レビュー指摘 🟢-4）
2. `supabase/cron/dispatch-deliveries.sql` の手順に従って
   `configure_delivery_cron` を再実行し、pg_cronを再構成する。
   `--configure-pg-cron` を使う場合、Vaultに書き込む `CRON_SECRET` の値が
   必要（`--cron-secret <value>` で既存の値を指定するか、
   `--rotate-cron-secret --secret-out <path>` で新しい値を生成する。
   後者を使う場合、ロールバック後にpg_cron経路だけが新しい値を使うことに
   なるので、Workers側は無効化済み＝この値を再度Workersに反映する必要はない）

   ```sh
   npm run deliveries:deploy -- --app-url <...> --confirm \
     --configure-pg-cron --cron-secret <Vaultの既存値 or 新しい値>
   ```
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
