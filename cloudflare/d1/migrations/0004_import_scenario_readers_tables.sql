-- issue #29 [移行 P5]: import_scenario_readers (supabase/migrations/20260902010000 が最終版) を
-- TS へ移植するために必要なテーブルを D1 (SQLite) へ追加する。
--
-- import_scenario_readers が読み書きする他のテーブル（readers / scenario_readers /
-- reader_labels / scenarios / funnels / step_messages / deliveries）は
-- 0001_deliveries.sql / 0002_process_stripe_purchase_tables.sql / 0003_register_reader_tables.sql
-- で作成済み。今回このマイグレーションで追加するのは labels だけ
-- （0002 の reader_labels.label_id が指す先のテーブルが、この時点までまだ D1 に無かった）。
--
-- 0001/0002/0003 と同じ方針:
--   - id は uuid型が無いため text。新規行は crypto.randomUUID()（TS側）で生成する。
--   - timestamptz は text。UTC の ISO 8601 で格納する。
--   - 外部キー制約は張らない（0002/0003と同じ理由）。
--
-- unique (tenant_id, name) は Postgres 版
-- (supabase/migrations/20260813104008_initial_phase1_schema.sql の public.labels) の
-- unique (tenant_id, name) と同じ意味論（同一テナント内で同じ名前のラベルを二重作成しない）を
-- 維持する。import_scenario_readers の「存在しないラベルは自動作成して付与する」処理
-- （`insert ... on conflict (tenant_id, name) do nothing` → `select id ...`）は、この
-- unique制約が無いと同名ラベルが行ごとに複製されてしまう（冪等性が壊れる）ため必須。

create table labels (
  id text primary key,
  tenant_id text not null,
  name text not null,
  created_at text not null,
  unique (tenant_id, name)
);
