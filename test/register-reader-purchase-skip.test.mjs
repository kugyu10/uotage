import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// DB を起動できないため、SQL は正規化した本文のパターンで検証する。
// 振る舞いの検証は test/unit/*.ts（実装を import するテスト）側に置く。
const registerReader = (await readFile(new URL('../supabase/migrations/20260901010000_register_reader_purchase_skip_and_cooldown.sql', import.meta.url), 'utf8'));
const normalized = registerReader.replace(/\s+/g, ' ').toLowerCase();
const claim = (await readFile(new URL('../supabase/migrations/20260901020000_claim_deliveries_hoist_target_funnel.sql', import.meta.url), 'utf8')).replace(/\s+/g, ' ').toLowerCase();
const registrationsRoute = await readFile(new URL('../src/app/api/registrations/route.ts', import.meta.url), 'utf8');

test('register_reader v6 replaces the previous version rather than adding an overload', () => {
  assert.match(normalized, /drop function public\.register_reader\(uuid, text, text, text, text, text, text\);/);
  assert.match(normalized, /create function public\.register_reader\(/);
  assert.match(normalized, /grant execute on function public\.register_reader\(uuid, text, text, text, text, text, text\) to service_role/);
  assert.match(normalized, /security definer/);
  assert.match(normalized, /set search_path = ''/);
});

test('the immediate first mail applies the same purchased-product skip as claim_deliveries', () => {
  // 対象商品が設定されていればその購入のみ、未設定ならテナント内のいずれかの購入。
  assert.match(
    normalized,
    /initial_purchase_skip := coalesce\(initial_skip_if_purchased, false\) and exists \( select 1 from public\.purchases purchase where purchase\.tenant_id = target_tenant_id and purchase\.reader_id = selected_reader\.id and \(selected_funnel\.product_id is null or purchase\.product_id = selected_funnel\.product_id\) \)/,
  );
  // 判定に使うフラグは1通目のステップ自身のもの。
  assert.match(normalized, /select initial\.id, initial\.skip_if_purchased into initial_step_id, initial_skip_if_purchased/);
});

test('a skipped first mail is finalised as skipped, never left as processing', () => {
  // processing のまま残すと claim_deliveries の10分スタック復旧が拾って送ってしまう。
  assert.match(
    normalized,
    /case when step\.id = initial_step_id and initial_purchase_skip then 'skipped' when step\.id = initial_step_id then 'processing' else 'queued' end/,
  );
  assert.match(normalized, /then 'delivery condition not met' end/);
});

test('a skipped first mail returns no subject/body/delivery id, so the API cannot send it', () => {
  assert.match(normalized, /and not had_enrollment and not initial_purchase_skip/);
});

test('the API only sends when the RPC handed back both subject and body', () => {
  // 送信の可否判断は register_reader の返り値だけに依存させる。
  assert.match(registrationsRoute, /if \(enrollment\.subject && enrollment\.body\) \{/);
  assert.doesNotMatch(registrationsRoute, /from\("purchases"\)/);
});

test('re-registration requeues the first mail only after the resend cooldown', () => {
  assert.match(normalized, /resend_cooldown constant interval := interval '10 minutes'/);
  assert.match(
    normalized,
    /and coalesce\(delivery\.sent_at, delivery\.scheduled_at\) <= now\(\) - resend_cooldown/,
  );
  // 再送はワーカー経由(queued)。processing に戻してフィルタを迂回させない。
  assert.match(normalized, /status = 'queued', scheduled_at = now\(\), processing_started_at = null/);
  assert.match(normalized, /and delivery\.status in \('sent', 'queued', 'failed', 'skipped'\)/);
});

test('unsubscribed readers still get no deliveries queued at all', () => {
  assert.match(normalized, /if selected_reader\.unsubscribed_at is null then/);
});

test('claim_deliveries resolves the target product outside the correlated subquery', () => {
  assert.match(claim, /public\.scenarios scenario left join public\.funnels target_funnel on target_funnel\.id = scenario\.funnel_id/);
  // 相関サブクエリの中に join を残さない（意図が結合の副作用に埋もれる）。
  assert.doesNotMatch(claim, /from public\.purchases purchase left join/);
  assert.match(claim, /\(target_funnel\.product_id is null or purchase\.product_id = target_funnel\.product_id\)/);
});
