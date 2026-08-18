import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const skipFix = (await readFile(new URL('../supabase/migrations/20260819030000_fix_skip_if_purchased.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const edge = await readFile(new URL('../supabase/functions/dispatch-deliveries/index.ts', import.meta.url), 'utf8');
const addAction = await readFile(new URL('../src/app/admin/mail/scenarios/[scenarioId]/readers/actions.ts', import.meta.url), 'utf8');

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

test('manual reader addition releases the pre-claimed first delivery back to the queue', () => {
  // register_reader は1通目を即時送信前提の processing で作るため、
  // 即時送信しない個別追加では queued に戻さないと10分間スタックする。
  assert.match(addAction, /initial_delivery_id/);
  assert.match(addAction, /\.update\(\{ status: "queued", processing_started_at: null \}\)/);
  assert.match(addAction, /\.eq\("status", "processing"\)/);
});
