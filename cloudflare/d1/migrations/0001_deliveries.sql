-- issue #10 [移行 P4] 配信キュー deliveries を D1 (SQLite) へ切り出す。
--
-- Postgres 版 (supabase/migrations/20260813104008 の public.deliveries) との差分:
--   - id は uuid 型がないため text。既存データ移送時は Postgres 側の uuid 文字列を
--     そのまま入れる。新規行も Worker 側で crypto.randomUUID() を使う。
--   - timestamptz も text。**必ず UTC の ISO 8601 ("YYYY-MM-DDTHH:MM:SS.SSSZ") で
--     格納する**こと。このフォーマットなら文字列比較が時刻比較と一致するため、
--     scheduled_at <= ? / processing_started_at < ? の判定がインデックスの効く
--     単純比較で書ける（src/lib/delivery-queue/claim.ts の toQueueTimestamp を使う）。
--   - 他テーブル (tenants / scenario_readers / step_messages / readers) は P4 時点では
--     Supabase 側に残るため、外部キー制約は張れない。参照整合性は書き込み側
--     （キュー投入時に Supabase 側で解決済みの id を渡す）で担保する。
--   - UNIQUE(scenario_reader_id, step_message_id) は送信の冪等性（同じ読者×同じステップに
--     二重にキューを積まない）の要なので必ず維持する。
--
-- rows read 課金対策: D1 の rows read は「スキャンした行数」で数える。毎分の claim が
-- (status, scheduled_at) の複合インデックスを使えないとテーブルフルスキャンになり、
-- sent/skipped が溜まるほど毎分の課金が増える。インデックスの利用は
-- test/unit/delivery-queue-claim.test.ts が EXPLAIN QUERY PLAN で検証している。

create table deliveries (
  id text primary key,
  tenant_id text not null,
  scenario_reader_id text not null,
  step_message_id text not null,
  reader_id text not null,
  scheduled_at text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'skipped', 'failed')),
  sent_at text,
  resend_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_message text,
  processing_started_at text,
  unique (scenario_reader_id, step_message_id)
);

create index deliveries_status_scheduled_at on deliveries (status, scheduled_at);
