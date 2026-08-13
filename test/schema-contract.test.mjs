import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20260813104008_initial_phase1_schema.sql',
  import.meta.url,
);
const sql = (await readFile(migrationUrl, 'utf8'))
  .replace(/--.*$/gm, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const tables = [
  'tenants',
  'operators',
  'delivery_accounts',
  'readers',
  'labels',
  'reader_labels',
  'funnels',
  'scenarios',
  'step_messages',
  'scenario_readers',
  'deliveries',
  'products',
  'purchases',
];

test('section 5.2 creates all 13 tables and enables RLS on each', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security;`),
    );
  }
});

test('token lookup indexes are explicit and do not rely on unique constraints', () => {
  assert.match(
    sql,
    /create index readers_access_token_idx on public\.readers \(access_token\);/,
  );
  assert.match(
    sql,
    /create index readers_unsubscribe_token_idx on public\.readers \(unsubscribe_token\);/,
  );
});

test('remaining section 5.3 indexes are explicit', () => {
  assert.match(
    sql,
    /create index deliveries_status_scheduled_at_idx on public\.deliveries \(status, scheduled_at\);/,
  );
  assert.match(
    sql,
    /create index reader_labels_label_id_idx on public\.reader_labels \(label_id\);/,
  );
});

test('purchase funnels require a product', () => {
  assert.match(
    sql,
    /constraint funnels_purchase_requires_product check \( trigger_type <> 'purchase' or product_id is not null \)/,
  );
});

test('registration funnels forbid a product', () => {
  assert.match(
    sql,
    /constraint funnels_registration_forbids_product check \( trigger_type <> 'registration' or product_id is null \)/,
  );
});

test('tenant-owned relationships use composite foreign keys', () => {
  const compositeForeignKeys = sql.match(
    /foreign key \(tenant_id, [a-z_]+\) references public\.[a-z_]+ \(tenant_id, id\)/g,
  );
  assert.ok(compositeForeignKeys, 'composite foreign keys should exist');
  assert.equal(compositeForeignKeys.length, 16);
});
