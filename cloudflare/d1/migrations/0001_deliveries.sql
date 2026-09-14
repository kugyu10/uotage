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
-- (status, scheduled_at, id) の複合インデックスを使えないとテーブルフルスキャンになり、
-- sent/skipped が溜まるほど毎分の課金が増える。インデックスの利用は
-- test/unit/delivery-queue-claim.test.ts が EXPLAIN QUERY PLAN で検証している。
--
-- id をインデックスに含めているのは、claim の `order by scheduled_at, id` の id タイブレークを
-- カバーするため。(status, scheduled_at) だけだと id の並べ替えに temp b-tree が挟まり、
-- limit があっても条件に合う行を全件読んでからソートすることになる（実測で確認済み）。
-- processing_started_at 更新時の書き込みコストは増えるが、インデックス列に含まれないため影響しない。
--
-- Postgres 版には復旧 UPDATE 用の deliveries_processing_recovery_idx (processing_started_at) が
-- 別途あるが、D1 側では意図的に作っていない。復旧 UPDATE は status = 'processing' の絞り込みだけで
-- 本インデックスの先頭列が効くため（実測: SEARCH ... USING INDEX deliveries_status_scheduled_at
-- (status=?)）、実害は薄いと判断した。

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

create index deliveries_status_scheduled_at on deliveries (status, scheduled_at, id);
