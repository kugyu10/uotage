// issue #3: CSVインポート経路のレートリミット。
// 判定ロジック自体は test/unit/rate-limit.test.ts が検証する。ここでは import できないもの
// （SQL関数、"use server" の Server Action）の配線が外れていないことをパターンで確認する
// （test/import-export-limits.test.mjs と同じ流儀）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const migrationSource = await read('../supabase/migrations/20260914010000_rate_limit_counters.sql');
const migrationSql = migrationSource.replace(/\s+/g, ' ').toLowerCase();
const importActions = await read('../src/app/admin/mail/scenarios/[scenarioId]/import/actions.ts');
const rateLimitTs = await read('../src/lib/rate-limit.ts');
const serverTs = await read('../src/lib/supabase/server.ts');

test('consume_rate_limit は SECURITY DEFINER + service_role 限定で、テーブルは RPC 以外から触れない', () => {
  assert.match(migrationSql, /security definer/);
  assert.match(migrationSql, /set search_path = ''/);
  // on conflict (limit_key, ...) の推論句は引数 limit_key と衝突して 42702 になる。
  // register_reader の同種障害 (20260902020000) と同じ対策が入っていること。
  // 実挙動の確認は scripts/verify-rate-limit.mjs（migration 適用後に必ず実行）。
  assert.match(migrationSql, /#variable_conflict use_column/);
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

test('PostgREST の名前付き引数は SQL 関数の引数名と一致している', () => {
  // 一致していないと PostgREST が関数を解決できず、fail-open のため静かに
  // 「レートリミットが一度も効かない」状態になる（レビューの空振り検査 S10）。
  // 実行時に気づけないので、TS と SQL の契約をここで固定する。
  const signature = migrationSource.match(
    /create function public\.consume_rate_limit\(([\s\S]*?)\)\s*returns/,
  );
  assert.ok(signature, 'consume_rate_limit の定義が見つからない');
  const sqlArgNames = signature[1]
    .split(',')
    .map((arg) => arg.trim().split(/\s+/)[0])
    .filter(Boolean);

  const rpcCall = rateLimitTs.match(/rpc\("consume_rate_limit",\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(rpcCall, 'src/lib/rate-limit.ts の rpc 呼び出しが見つからない');
  const tsArgNames = [...rpcCall[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);

  assert.deepEqual(tsArgNames.slice().sort(), sqlArgNames.slice().sort());
  // 型定義側（RateLimitRpcClient）の引数名も同じ契約に乗っていること。
  for (const name of sqlArgNames) {
    assert.match(rateLimitTs, new RegExp(`${name}: (string|number)`));
  }
});

test('previewImport と confirmImport は重い処理より前にレートリミットを消費する', () => {
  const previewFn = importActions.slice(
    importActions.indexOf('export async function previewImport'),
    importActions.indexOf('export interface ConfirmState'),
  );
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));

  for (const [name, fn] of [['previewImport', previewFn], ['confirmImport', confirmFn]]) {
    const consumeAt = fn.indexOf('consumeImportRateLimit(operator.user_id)');
    assert.ok(consumeAt >= 0, `${name} がレートリミットを消費していない`);
    // 重い処理＝ファイル本体の読み込みと DB 往復。どちらもレートリミットより後に来る。
    for (const heavy of ['await file.text()', '.from("scenarios")']) {
      const heavyAt = fn.indexOf(heavy);
      if (heavyAt >= 0) {
        assert.ok(consumeAt < heavyAt, `${name} は ${heavy} より前に消費すべき`);
      }
    }
    assert.match(fn, /RATE_LIMIT_ERROR/);
  }

  // 逆に、I/O を伴わない安価な入力チェックはレートリミットより前に置く
  // （操作ミスで枠を食い潰さない。issue #3 レビュー 🟢8）。
  assert.ok(
    previewFn.indexOf('MAX_FILE_SIZE_BYTES') < previewFn.indexOf('consumeImportRateLimit'),
    'previewImport のサイズ上限チェックはレートリミットより前に置くべき',
  );
  assert.ok(
    confirmFn.indexOf('MAX_IMPORT_ROWS') < confirmFn.indexOf('consumeImportRateLimit'),
    'confirmImport の行数上限チェックはレートリミットより前に置くべき',
  );
});

test('レートリミットのキーは per-operator（operators.user_id）', () => {
  // Cloudflare Access 移行後、オペレーターの識別子は operators.user_id
  // （Access が検証した正規化済みメールアドレス）。requireOperator がこれを返し続けること。
  assert.match(serverTs, /\.select\("tenant_id, user_id"\)/);
  assert.match(importActions, /importRateLimitKey\(operatorId\)/);
  assert.match(importActions, /consumeImportRateLimit\(operator\.user_id\)/);
});
