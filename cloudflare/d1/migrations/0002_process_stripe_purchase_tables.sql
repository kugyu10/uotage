-- issue #29 [移行 P5]: process_stripe_purchase (supabase/migrations/20260815020000) を
-- TS へ移植するために必要なテーブルを D1 (SQLite) へ追加する。
--
-- 対象を「process_stripe_purchase が実際に読み書きするテーブルだけ」に絞っている
-- （register_reader / import_scenario_readers はこの issue のスコープ外 — #29 参照）。
-- そのため tenants / labels / delivery_accounts / operators / registration_paths は
-- まだ作らない。今回作る funnels.product_id / scenarios.delivery_account_id /
-- reader_labels.label_id のように、まだ存在しないテーブルを指す列は残るが、
-- 0001_deliveries.sql と同じ理由（下記）で外部キー制約は張らず、列だけ用意する。
--
-- Postgres 版 (supabase/migrations/20260813104008 の該当テーブル) との差分は
-- 0001_deliveries.sql と同じ方針:
--   - id は uuid 型がないため text。新規行は crypto.randomUUID()（TS側）で生成する。
--   - timestamptz は text。**必ず UTC の ISO 8601 ("YYYY-MM-DDTHH:MM:SS.SSSZ") で
--     格納する**（src/lib/delivery-queue/claim.ts の toQueueTimestamp と同じ規約）。
--   - boolean は integer (0/1)。SQLite に真偽型は無い。
--   - jsonb は text。JSON文字列としてそのまま格納する（readers.custom_fields のみ該当）。
--   - RLS ポリシー・is_tenant_operator() は無い。テナント分離は
--     src/lib/d1/tenant-db.ts の createTenantDb が実行時に強制する（ADR 参照）。
--   - 外部キー制約は張らない。他テーブル（tenants 含む）が P5 時点でまだ全部
--     揃っていないことに加え、D1 は書き込みが単一 writer で直列実行されるため
--     Postgres の FOR UPDATE 相当の行ロックが不要な設計（ADR 方式A: DOによる
--     テナント単位の直列化）であり、参照整合性はアプリコード（この移植では
--     src/lib/purchases/process-stripe-purchase.ts）の責務とする。
--
-- unique 制約は移植対象関数の冪等性・一意性の要なので Postgres 版のまま維持する:
--   - readers: unique (tenant_id, email) — 同一テナント内でのメール重複登録を防ぐ
--   - readers: unique (access_token) / unique (unsubscribe_token) — トークンの推測衝突防止
--   - purchases: unique (stripe_session_id) — Stripe re送の冪等性（本関数の要）
--   - reader_labels: primary key (reader_id, label_id) — 同一ラベルの二重付与防止
--   - funnels: unique (tenant_id, slug)
--   - scenario_readers: unique (reader_id, scenario_id) — 同一シナリオへの二重登録防止

create table products (
  id text primary key,
  tenant_id text not null,
  name text not null,
  stripe_price_id text not null,
  content_url text,
  post_purchase_scenario_id text,
  post_purchase_label_id text,
  created_at text not null
);

create table readers (
  id text primary key,
  tenant_id text not null,
  email text not null,
  name text,
  custom_fields text not null default '{}',
  access_token text not null,
  unsubscribe_token text not null,
  unsubscribed_at text,
  created_at text not null,
  unique (tenant_id, email),
  unique (access_token),
  unique (unsubscribe_token)
);

create table purchases (
  id text primary key,
  tenant_id text not null,
  reader_id text not null,
  product_id text not null,
  stripe_session_id text not null,
  amount integer check (amount >= 0),
  purchased_at text not null,
  unique (stripe_session_id)
);

create table reader_labels (
  tenant_id text not null,
  reader_id text not null,
  label_id text not null,
  granted_at text not null,
  primary key (reader_id, label_id)
);

create table funnels (
  id text primary key,
  tenant_id text not null,
  name text not null,
  slug text not null,
  trigger_type text not null check (trigger_type in ('registration', 'purchase')),
  product_id text,
  deadline_hours integer not null check (deadline_hours >= 0),
  booking_url text,
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null,
  unique (tenant_id, slug)
);

create table scenarios (
  id text primary key,
  tenant_id text not null,
  delivery_account_id text not null,
  funnel_id text,
  name text not null,
  is_active integer not null default 1 check (is_active in (0, 1)),
  created_at text not null
);

create table step_messages (
  id text primary key,
  tenant_id text not null,
  scenario_id text not null,
  position integer not null check (position >= 0),
  delay_minutes integer not null check (delay_minutes >= 0),
  send_at_hour integer check (send_at_hour between 0 and 23),
  subject text not null,
  body text not null,
  skip_if_purchased integer not null default 1 check (skip_if_purchased in (0, 1)),
  grant_label_id text,
  created_at text not null
);

create table scenario_readers (
  id text primary key,
  tenant_id text not null,
  reader_id text not null,
  scenario_id text not null,
  registered_at text not null,
  registration_path text,
  deadline_at text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  unique (reader_id, scenario_id)
);

-- process_stripe_purchase が読む側だけに使う索引。
-- readers はメールでの照合（tenant_id, email の UNIQUE 索引で足りる）以外に
-- 明示的な索引は不要（要件定義書 5.3 のトークン索引は access_token / unsubscribe_token
-- の unique 制約が SQLite でそのまま索引を兼ねるため、register_reader 移植 (#29) 時点で
-- 追加作業なしで満たされている。0003_register_reader_tables.sql 参照）。
create index step_messages_scenario_idx on step_messages (tenant_id, scenario_id);
