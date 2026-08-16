import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const webhook = await readFile(new URL('../src/app/api/stripe/webhook/route.ts', import.meta.url), 'utf8');
const sql = (await readFile(new URL('../supabase/migrations/20260815020000_process_stripe_purchase.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();

test('Stripe webhook verifies raw body signature before processing', () => {
  assert.match(webhook, /constructEvent\(await request\.text\(\), signature, serverEnv\.stripeWebhookSecret\)/);
  assert.ok(webhook.indexOf('constructEvent') < webhook.indexOf('process_stripe_purchase'));
  assert.match(webhook, /session\.payment_status !== "paid"/);
});

test('purchase transaction is idempotent and tenant-scoped', () => {
  assert.match(sql, /if exists \(select 1 from public\.purchases where stripe_session_id = stripe_session\) then return/);
  assert.match(sql, /on conflict \(stripe_session_id\) do nothing/);
  assert.match(sql, /where tenant_id = target_tenant_id and id = product/);
  assert.match(sql, /on conflict \(reader_id, scenario_id\) do update/);
});
