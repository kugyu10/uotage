// issue #3: CSVインポート経路のレートリミット。
// 判定ロジック自体は test/unit/rate-limit.test.ts が検証する。ここでは import できないもの
// （SQL関数、"use server" の Server Action）の配線が外れていないことをパターンで確認する
// （test/import-export-limits.test.mjs と同じ流儀）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const migrationSql = (await read('../supabase/migrations/20260914010000_rate_limit_counters.sql'))
  .replace(/\s+/g, ' ')
  .toLowerCase();
const importActions = await read('../src/app/admin/mail/scenarios/[scenarioId]/import/actions.ts');
const serverTs = await read('../src/lib/supabase/server.ts');

test('consume_rate_limit は SECURITY DEFINER + service_role 限定で、テーブルは RPC 以外から触れない', () => {
  assert.match(migrationSql, /security definer/);
  assert.match(migrationSql, /set search_path = ''/);
  assert.match(migrationSql, /revoke all on function public\.consume_rate_limit\(text, integer, integer\) from public/);
  assert.match(migrationSql, /grant execute on function public\.consume_rate_limit\(text, integer, integer\) to service_role/);
  // RLS 有効・ポリシー無し = service_role（RLSを通らない）以外はテーブルに触れない。
  assert.match(migrationSql, /alter table public\.rate_limit_counters enable row level security/);
  assert.doesNotMatch(migrationSql, /create policy/);
});

test('カウンタは固定窓で加算され、古い窓は掃除される', () => {
  assert.match(migrationSql, /on conflict \(limit_key, window_start\) do update set request_count = counters\.request_count \+ 1/);
  assert.match(migrationSql, /delete from public\.rate_limit_counters/);
  assert.match(migrationSql, /window_start < current_window/);
  // 拒否の判定は「加算後のカウントが上限以下か」。
  assert.match(migrationSql, /return current_count <= max_requests/);
});

test('previewImport と confirmImport は重い処理（ファイル読み込み）より前にレートリミットを消費する', () => {
  const previewFn = importActions.slice(
    importActions.indexOf('export async function previewImport'),
    importActions.indexOf('export interface ConfirmState'),
  );
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));

  for (const [name, fn] of [['previewImport', previewFn], ['confirmImport', confirmFn]]) {
    const consumeAt = fn.indexOf('consumeImportRateLimit(userId)');
    assert.ok(consumeAt >= 0, `${name} がレートリミットを消費していない`);
    const fileReadAt = fn.indexOf('formData.get("file")');
    if (fileReadAt >= 0) {
      assert.ok(consumeAt < fileReadAt, `${name} はファイルを読む前に消費すべき`);
    }
    assert.match(fn, /RATE_LIMIT_ERROR/);
  }
});

test('レートリミットのキーは per-operator（auth のユーザーID）', () => {
  assert.match(serverTs, /userId: auth\.user\.id/);
  assert.match(importActions, /importRateLimitKey\(userId\)/);
});
