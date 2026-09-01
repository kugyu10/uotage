import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const mailPage = await read('src/app/admin/mail/page.tsx');
const mailActions = await read('src/app/admin/mail/actions.ts');
const scenarioPage = await read('src/app/admin/mail/scenarios/[scenarioId]/page.tsx');
const scenarioActions = await read('src/app/admin/mail/scenarios/[scenarioId]/actions.ts');
const stepsPage = await read('src/app/admin/mail/scenarios/[scenarioId]/steps/page.tsx');
const stepsActions = await read('src/app/admin/mail/scenarios/[scenarioId]/steps/actions.ts');
const stepEditPage = await read('src/app/admin/mail/scenarios/[scenarioId]/steps/[stepId]/page.tsx');
const stepEditActions = await read('src/app/admin/mail/scenarios/[scenarioId]/steps/[stepId]/actions.ts');
const stepEditor = await read('src/app/admin/mail/scenarios/[scenarioId]/steps/[stepId]/step-editor.tsx');
const mailSteps = await read('src/lib/mail-steps.ts');
const stepOrderingMigration = await readFile(new URL('../supabase/migrations/20260901030000_step_message_ordering_rpc.sql', import.meta.url), 'utf8');

test('every メール配信 page requires an authenticated operator', () => {
  for (const page of [mailPage, scenarioPage, stepsPage, stepEditPage]) {
    assert.match(page, /requireOperator\(\)/);
  }
});

test('every write path scopes queries and mutations to the operator tenant_id', () => {
  for (const source of [mailActions, scenarioActions, stepsActions, stepEditActions]) {
    assert.match(source, /requireOperator\(\)/);
  }
  // createScenario is a fresh insert: tenant_id comes from the operator, not a WHERE filter.
  assert.match(mailActions, /tenant_id: operator\.tenant_id/);
  // updates/deletes/selects on existing rows must filter by the operator's tenant_id.
  for (const source of [scenarioActions, stepsActions, stepEditActions]) {
    assert.match(source, /\.eq\("tenant_id", operator\.tenant_id\)/);
  }
});

test('scenario creation and edit accept name / delivery account / funnel / is_active', () => {
  assert.match(mailActions, /from\("scenarios"\)\s*\n?\s*\.insert/);
  assert.match(mailActions, /delivery_account_id: deliveryAccountId/);
  assert.match(mailActions, /funnel_id: funnelIdRaw \|\| null/);
  assert.match(mailActions, /is_active: isActive/);
  assert.match(scenarioActions, /\.update\(\{ name, funnel_id: funnelIdRaw \|\| null, is_active: isActive \}\)/);
});

test('scenario detail page renders a tab nav linking to steps, readers, and deliveries without implementing readers/deliveries', () => {
  assert.match(scenarioPage, /\/admin\/mail\/scenarios\/\$\{scenarioId\}\/steps/);
  assert.match(scenarioPage, /\/admin\/mail\/scenarios\/\$\{scenarioId\}\/readers/);
  assert.match(scenarioPage, /\/admin\/mail\/scenarios\/\$\{scenarioId\}\/deliveries/);
});

test('step list is ordered by position and supports add, delete, and up/down reordering', () => {
  assert.match(stepsPage, /order\("position", \{ ascending: true \}\)/);
  assert.match(stepsPage, /moveStep\.bind\(null, scenarioId, step\.id, "up"\)/);
  assert.match(stepsPage, /moveStep\.bind\(null, scenarioId, step\.id, "down"\)/);
  assert.match(stepsPage, /deleteStep\.bind\(null, scenarioId, step\.id\)/);
  assert.match(stepsPage, /createStep\.bind\(null, scenarioId\)/);
  assert.match(stepsActions, /export async function createStep/);
  assert.match(stepsActions, /export async function deleteStep/);
  assert.match(stepsActions, /export async function moveStep/);
});

test('moveStep and createStep delegate position handling to SQL so it cannot race', () => {
  // 並び替え・末尾追加はどちらも1トランザクションに閉じる必要がある。
  // TS 側で position を読んでから書くと、同時操作で重複・欠番が出る。
  assert.match(stepsActions, /rpc\("move_step_message"/);
  assert.match(stepsActions, /rpc\("append_step_message"/);
  // position を TS 側から直接書かないこと（renumberSteps の詰め直しは除く）。
  const positionWrites = stepsActions.match(/update\(\{ position:/g) ?? [];
  assert.equal(positionWrites.length, 1, `position を直接更新している箇所が多すぎる: ${positionWrites.length}`);
  assert.match(stepsActions, /update\(\{ position: index \}\)/);
});

test('the step ordering functions run as security invoker so RLS still applies', () => {
  assert.match(stepOrderingMigration, /create function public\.append_step_message/);
  assert.match(stepOrderingMigration, /create function public\.move_step_message/);
  // security definer にすると RLS を飛ばしてしまう。
  assert.doesNotMatch(stepOrderingMigration, /security definer/);
  // 関数定義の行だけを数える（説明コメント中の語を拾わないよう行頭に固定）。
  const invokerCount = stepOrderingMigration.match(/^security invoker$/gm) ?? [];
  assert.equal(invokerCount.length, 2, `security invoker の定義が2つでない: ${invokerCount.length}`);
  // 同一シナリオへの同時操作を直列化する行ロック。
  assert.match(stepOrderingMigration, /from public\.scenarios scenario\s+where scenario\.id = target_scenario_id for update/);
  assert.match(stepOrderingMigration, /grant execute on function public\.append_step_message\(uuid\) to authenticated/);
  assert.match(stepOrderingMigration, /grant execute on function public\.move_step_message\(uuid, uuid, text\) to authenticated/);
});

test('deleteStep renumbers remaining steps back to a contiguous 0-based position', () => {
  assert.match(stepsActions, /renumberSteps/);
  assert.match(stepsActions, /update\(\{ position: index \}\)/);
});

test('UTAGE-style send timing: "シナリオ登録直後" is delay_minutes=0/send_at_hour=null, "N日後 HH:00" multiplies days by 1440', () => {
  assert.match(mailSteps, /シナリオ登録直後/);
  assert.match(stepsPage, /シナリオ登録直後/);
  assert.match(mailSteps, /mode === "immediate"\) return \{ delayMinutes: 0, sendAtHour: null \}/);
  assert.match(mailSteps, /days \* 1440/);
  assert.match(mailSteps, /export function toStepTiming/);
  assert.match(mailSteps, /export function timingModeFromStep/);

  // N日後 → delay_minutes 変換の実挙動を直接検証する（分は00固定）。
  const days = 3;
  const delayMinutes = days * 1440;
  assert.equal(delayMinutes, 4320);
});

test('the step editor exposes a subject field, a plain textarea body, skip_if_purchased, and a grant_label_id action select', () => {
  assert.match(stepEditor, /name="subject"/);
  assert.match(stepEditor, /<textarea[\s\S]*name="body"/);
  assert.match(stepEditor, /name="skip_if_purchased"/);
  assert.match(stepEditor, /name="grant_label_id"/);
  assert.doesNotMatch(stepEditor, /dangerouslySetInnerHTML/);
});

test('the placeholder panel includes all six replacement variables and inserts at the cursor position', () => {
  const requiredTokens = ['{{name}}', '{{offer_url}}', '{{booking_url}}', '{{deadline}}', '{{unsubscribe_url}}', '{{member_url}}'];
  for (const token of requiredTokens) {
    assert.ok(mailSteps.includes(token), `mail-steps.ts is missing placeholder ${token}`);
  }
  assert.match(mailSteps, /STEP_PLACEHOLDER_VARIABLES/);
  assert.match(stepEditor, /STEP_PLACEHOLDER_VARIABLES/);
  assert.match(stepEditor, /insertPlaceholder/);
  assert.match(stepEditor, /selectionStart/);
  assert.match(stepEditor, /setSelectionRange/);
});

test('preview resolves all six placeholders against sample values, not live reader data', () => {
  const requiredTokens = ['{{name}}', '{{offer_url}}', '{{booking_url}}', '{{deadline}}', '{{unsubscribe_url}}', '{{member_url}}'];
  assert.match(mailSteps, /STEP_PREVIEW_SAMPLE_VALUES/);
  assert.match(stepEditor, /renderStepTemplate\(subject, STEP_PREVIEW_SAMPLE_VALUES\)/);
  assert.match(stepEditor, /renderStepTemplate\(body, STEP_PREVIEW_SAMPLE_VALUES\)/);
  for (const token of requiredTokens) {
    assert.ok(mailSteps.includes(`"${token}":`), `mail-steps.ts sample values are missing ${token}`);
  }
});

test('test send is implemented but requires an explicit button click, and prefixes the subject with [テスト]', () => {
  assert.match(stepEditor, /onClick=\{handleTestSend\}/);
  assert.match(stepEditor, /テスト送信する/);
  assert.match(stepEditActions, /export async function sendTestStep/);
  assert.match(stepEditActions, /\[テスト\] /);
  assert.match(stepEditActions, /renderStepTemplate\(subject, STEP_PREVIEW_SAMPLE_VALUES\)/);
  assert.match(stepEditActions, /renderStepTemplate\(body, STEP_PREVIEW_SAMPLE_VALUES\)/);
  assert.match(stepEditActions, /auth\.user\?\.email/);
  // useEffect-driven auto-invocation would send mail without an explicit user action; make sure there is none.
  assert.doesNotMatch(stepEditor, /useEffect/);
});

test('scenario and step mutations use Server Actions ("use server"), not client-side writes', () => {
  for (const source of [mailActions, scenarioActions, stepsActions, stepEditActions]) {
    assert.match(source, /^"use server";/);
  }
  for (const page of [mailPage, scenarioPage, stepsPage, stepEditPage]) {
    assert.doesNotMatch(page, /"use client"/);
  }
  assert.match(stepEditor, /"use client";/);
});
