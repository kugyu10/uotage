import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const skipFix = (await readFile(new URL('../supabase/migrations/20260819030000_fix_skip_if_purchased.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const targetSkip = (await readFile(new URL('../supabase/migrations/20260819040000_target_product_skip_and_grant_label.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const importFix = (await readFile(new URL('../supabase/migrations/20260819050000_import_unsubscribed_and_initial_grant.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const edge = await readFile(new URL('../supabase/functions/dispatch-deliveries/index.ts', import.meta.url), 'utf8');
const addAction = await readFile(new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/actions.ts', import.meta.url), 'utf8');
const importRows = await readFile(new URL('../src/lib/csv/import-rows.ts', import.meta.url), 'utf8');
const importAction = await readFile(new URL('../src/app/admin/mail/scenarios/[scenarioId]/import/actions.ts', import.meta.url), 'utf8');
const registrationRoute = await readFile(new URL('../src/app/api/registrations/route.ts', import.meta.url), 'utf8');

test('skip_if_purchased no longer joins purchases through the registration funnel product', () => {
  // 登録ファネルは product_id が必ず NULL のため、旧述語は恒偽だった。
  assert.doesNotMatch(skipFix, /purchase\.product_id = funnel\.product_id/);
  assert.match(skipFix, /purchase\.tenant_id = delivery\.tenant_id and purchase\.reader_id = reader\.id/);
  // 購入トリガーのシナリオ（読者全員が購入者）はスキップ判定の対象外。
  assert.match(skipFix, /not exists \( select 1 from public\.funnels funnel where funnel\.id = scenario\.funnel_id and funnel\.trigger_type = 'purchase' \)/);
});

test('dispatch worker renders {{deadline}} in Japan time instead of the raw timestamptz', () => {
  assert.match(edge, /Intl\.DateTimeFormat\("ja-JP",.*timeZone: "Asia\/Tokyo"/);
  assert.match(edge, /"\{\{deadline\}\}": deadlineFormat\.format\(new Date\(item\.deadline_at\)\)/);
});

test('skip_if_purchased targets the funnel product when one is set', () => {
  // 対象商品が設定された登録ファネルは、その商品の購入のみでスキップする(4.3-4)。
  assert.match(targetSkip, /drop constraint if exists funnels_registration_forbids_product/);
  assert.match(targetSkip, /target_funnel\.product_id is null or purchase\.product_id = target_funnel\.product_id/);
});

test('grant_label_id is applied after sending, in both delivery paths', () => {
  // 配信ワーカー経由
  assert.match(targetSkip, /step\.grant_label_id/);
  assert.match(edge, /grant_label_id/);
  assert.match(edge, /from\("reader_labels"\)\.upsert\(/);
  // 登録フォーム経由の1通目(即時送信)
  assert.match(importFix, /initial_grant_label_id/);
  assert.match(registrationRoute, /initial_grant_label_id/);
  assert.match(registrationRoute, /from\("reader_labels"\)\.upsert\(/);
});

test('CSV import honors the 解除状況 column instead of discarding it', () => {
  assert.match(importRows, /header\.indexOf\("解除状況"\)/);
  assert.match(importRows, /=== "解除済み"/);
  assert.match(importAction, /unsubscribed: row\.unsubscribed/);
  // 解除済み読者: unsubscribed_at を設定し(既存値は維持)、deliveries は積まない。
  assert.match(importFix, /coalesce\(unsubscribed_at, execution_time\)/);
  assert.match(importFix, /and selected_reader\.unsubscribed_at is null/);
});

test('re-registration resends the first mail and unsubscribed readers get nothing', async () => {
  const registerV4 = (await readFile(
    new URL('../supabase/migrations/20260819060000_register_reader_resend_and_unsubscribed.sql', import.meta.url),
    'utf8',
  )).replace(/\s+/g, ' ').toLowerCase();
  // 重複登録(4.1-2): 1通目をprocessingに戻して既存送信パスで再送する(期限はリセットしない)。
  assert.match(registerV4, /had_enrollment/);
  assert.match(registerV4, /status in \('sent', 'queued', 'failed', 'skipped'\)/);
  // 解除済み読者(4.3-4): deliveriesを積まず、1通目の送信材料も返さない。
  assert.match(registerV4, /if selected_reader\.unsubscribed_at is null then/);
  assert.match(registerV4, /and selected_reader\.unsubscribed_at is null order by step\.position/);
});

test('manual reader addition releases the pre-claimed first delivery back to the queue', () => {
  // register_reader は1通目を即時送信前提の processing で作るため、
  // 即時送信しない個別追加では queued に戻さないと10分間スタックする。
  assert.match(addAction, /initial_delivery_id/);
  assert.match(addAction, /\.update\(\{ status: "queued", processing_started_at: null \}\)/);
  assert.match(addAction, /\.eq\("status", "processing"\)/);
});
