-- issue #29 [移行 P5]: register_reader (supabase/migrations/20260902020000 が最終版) を
-- TS へ移植するために必要なテーブルを D1 (SQLite) へ追加する。
--
-- register_reader が読み書きする他のテーブル（funnels / scenarios / step_messages /
-- scenario_readers / readers / reader_labels / deliveries）は
-- 0001_deliveries.sql / 0002_process_stripe_purchase_tables.sql で作成済みで、
-- 必要な列（funnels.product_id, step_messages.skip_if_purchased / grant_label_id,
-- readers.unsubscribed_at, deliveries.processing_started_at / error_message）も
-- process_stripe_purchase 移植時点で既に用意されている。今回このマイグレーションで
-- 追加するのは registration_paths だけ。
--
-- 0001/0002 と同じ方針:
--   - id は uuid型が無いため text。新規行は crypto.randomUUID()（TS側）で生成する。
--   - timestamptz は text。UTC の ISO 8601 で格納する。
--   - 外部キー制約は張らない。tenant_id・funnel_id の参照整合性はテナント境界の
--     強制（src/lib/d1/tenant-db.ts）とアプリコードの責務にする（0002と同じ理由）。
--   - label_id は labels テーブルがまだ D1 に無いため FK を張らず列だけ用意する
--     （0002_process_stripe_purchase_tables.sql の reader_labels.label_id と同じ扱い）。
--
-- unique (tenant_id, funnel_id, path) は Postgres 版
-- (supabase/migrations/20260813104008_initial_phase1_schema.sql の
-- public.registration_paths) の unique (tenant_id, funnel_id, path) と同じ意味論
-- （同一ファネル内で同じ登録経路(path)を二重に作らない）を維持する。

create table registration_paths (
  id text primary key,
  tenant_id text not null,
  funnel_id text not null,
  path text not null,
  name text not null,
  label_id text,
  created_at text not null,
  unique (tenant_id, funnel_id, path)
);

-- register_reader が登録1件ごとに引く2つの検索に索引を足す（レビュー指摘 🟢-3）。
-- registration_paths 自体は unique (tenant_id, funnel_id, path) が検索条件を
-- そのまま覆っているため追加不要。
--   - purchases where tenant_id = ? and reader_id = ? （購入済みスキップ判定）
--   - scenarios where tenant_id = ? and funnel_id = ? and is_active = 1
--     order by created_at, id （アクティブシナリオの解決）
create index purchases_tenant_reader_idx on purchases (tenant_id, reader_id);
create index scenarios_tenant_funnel_active_idx on scenarios (tenant_id, funnel_id, is_active);
