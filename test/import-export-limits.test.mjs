// コードレビュー指摘（高）: CSVインポートの行数上限とバッチ分割、CSVエクスポートの件数上限。
//
// 分割・合算・ページングそのものの振る舞いは実装を import して検証している
// （test/unit/csv-import-batches.test.ts / test/unit/supabase-paginate.test.ts）。
// ここでは import できないもの（SQL関数、"use server" の Server Action、Route Handler）
// について、配線が外れていないことだけをパターンで確認する。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { IMPORT_BATCH_SIZE, MAX_IMPORT_ROWS } from '../src/lib/csv/import-batches.ts';
import { SUPABASE_PAGE_SIZE } from '../src/lib/supabase/paginate.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const batchLimitSql = (await read('../supabase/migrations/20260819060000_import_batch_row_limit.sql'))
  .replace(/\s+/g, ' ')
  .toLowerCase();
const importActions = await read('../src/app/admin/mail/scenarios/[scenarioId]/import/actions.ts');
const importWizard = await read('../src/app/admin/mail/scenarios/[scenarioId]/import/ImportWizard.tsx');
const exportRoute = await read('../src/app/admin/mail/scenarios/[scenarioId]/export/route.ts');
const nextConfig = await read('../next.config.ts');

// ============================== 1) インポート: 行数上限とバッチ分割 ==============================

test('アプリ側のバッチサイズは、RPCが受け付ける上限を超えていない', () => {
  // SQL側は1回1000行までで raise exception する。定数を緩めたら気付けるようにする。
  const match = /jsonb_array_length\(rows\) > (\d+) then/.exec(batchLimitSql);
  assert.ok(match, 'RPCの行数ガードが見つからない');
  const rpcLimit = Number(match[1]);
  assert.ok(
    IMPORT_BATCH_SIZE <= rpcLimit,
    `IMPORT_BATCH_SIZE(${IMPORT_BATCH_SIZE}) が RPC の上限(${rpcLimit}) を超えている`,
  );
  // 上限行数がバッチサイズを下回ると分割の意味がない。
  assert.ok(MAX_IMPORT_ROWS > IMPORT_BATCH_SIZE);
});

test('行数ガードを足した migration も SECURITY DEFINER と service_role 限定を維持している', () => {
  assert.match(batchLimitSql, /security definer/);
  assert.match(batchLimitSql, /set search_path = ''/);
  assert.match(
    batchLimitSql,
    /revoke all on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, jsonb\) from public/,
  );
  assert.match(
    batchLimitSql,
    /grant execute on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, jsonb\) to service_role/,
  );
  // 冪等性の担保（再実行して二重登録しない）は行数ガード追加後も残っていること。
  assert.match(batchLimitSql, /on conflict \(reader_id, scenario_id\) do nothing/);
  assert.match(batchLimitSql, /on conflict \(scenario_reader_id, step_message_id\) do nothing/);
});

test('previewImport は行数上限を判定し、依然としてDBへ書き込まない', () => {
  const previewFn = importActions.slice(
    importActions.indexOf('export async function previewImport'),
    importActions.indexOf('export interface ConfirmState'),
  );
  assert.match(previewFn, /checkImportRowLimit\(parsed\.rows\.length, parsed\.invalidRows\.length\)/);
  assert.doesNotMatch(previewFn, /\.rpc\(/);
  assert.doesNotMatch(previewFn, /createAdminClient/);
});

test('confirmImport はRPCを1回ではなくバッチごとに呼び、サマリを合算する', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  assert.match(confirmFn, /chunkRows\(rowsPayload, IMPORT_BATCH_SIZE\)/);
  assert.match(confirmFn, /for \(const batch of batches\)/);
  assert.match(confirmFn, /rows: batch,/);
  assert.match(confirmFn, /addImportSummary\(summary, toImportSummary\(data\[0\]\)\)/);
  // 全行を1回で渡す実装に戻っていないこと。
  assert.doesNotMatch(confirmFn, /rows: rowsPayload,/);
});

test('バッチ途中の失敗は status="partial" として、どこまで反映されたかを返す', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  assert.match(confirmFn, /status: "partial"/);
  assert.match(confirmFn, /processedRows,/);
  assert.match(confirmFn, /totalRows: rowsPayload\.length,/);
  // 1バッチ目で失敗（=何も反映されていない）ときだけ通常のエラー扱いにする。
  assert.match(confirmFn, /if \(processedRows === 0\)/);
});

test('UIは部分適用を専用の文言で伝え、再実行が安全であることを案内する', () => {
  assert.match(importWizard, /confirmState\.status === "partial"/);
  assert.match(importWizard, /先頭から\{confirmState\.processedRows\}行目までは反映済みです/);
  assert.match(importWizard, /既に登録済みのためスキップ/);
  // 行数上限をユーザーに事前提示する。
  assert.match(importWizard, /MAX_IMPORT_ROWS\.toLocaleString\("ja-JP"\)/);
});

test('Server Action のボディ上限を引き上げている（既定1MBでは5MBのCSVが通らない）', () => {
  assert.match(nextConfig, /serverActions: \{/);
  const match = /bodySizeLimit: "(\d+)mb"/.exec(nextConfig);
  assert.ok(match, 'bodySizeLimit が設定されていない');
  assert.ok(Number(match[1]) >= 6, `bodySizeLimit(${match[1]}mb) が 5MB のアップロードに足りない`);
});

// ============================== 2) エクスポート: 件数上限 ==============================

test('エクスポートは読者IDを全件 .in() に渡さず、ページングして積み上げる', () => {
  // 起点の scenario_readers を .range() で回している。
  assert.match(exportRoute, /\.range\(from, from \+ SUPABASE_PAGE_SIZE - 1\)/);
  assert.match(exportRoute, /fetchAllPages</);
  // .in() に渡すのは1ページ分の reader_id だけ（URI長が有界）。
  assert.match(exportRoute, /const readerIds = Array\.from\(new Set\(page\.map\(\(row\) => row\.reader_id\)\)\)/);
  // ページ境界がずれないよう、必ず order を付けている。
  for (const table of ['readers', 'reader_labels', 'purchases', 'scenario_readers', 'labels', 'products']) {
    const section = exportRoute.slice(exportRoute.indexOf(`.from("${table}")`));
    assert.match(section.slice(0, 400), /\.order\(/, `${table} に order が無い（ページングが不安定）`);
  }
  // 1ページのサイズは .in() のURI長を有界にする値と同じ定数を使う。
  assert.ok(SUPABASE_PAGE_SIZE <= 1000, `SUPABASE_PAGE_SIZE(${SUPABASE_PAGE_SIZE}) が大きすぎる`);
});

test('エクスポートは上限超過時に不完全なCSVを返さず 413 にする', () => {
  assert.match(exportRoute, /MAX_PAGINATED_ROWS\) throw new Error\(TOO_MANY_ROWS\)/);
  assert.match(exportRoute, /error\.message === TOO_MANY_ROWS/);
  assert.match(exportRoute, /status: 413/);
});

test('エクスポートは tenant_id スコープと CSV ヘッダーを維持している', () => {
  assert.match(exportRoute, /requireOperator/);
  assert.match(exportRoute, /buildScenarioExportCsv/);
  assert.match(exportRoute, /"Content-Type": "text\/csv; charset=utf-8"/);
  // ページングで追加したクエリすべてに tenant_id スコープが付いていること。
  const froms = exportRoute.match(/\.from\("[a-z_]+"\)/g) ?? [];
  const scoped = exportRoute.match(/\.eq\("tenant_id", operator\.tenant_id\)/g) ?? [];
  assert.equal(froms.length, scoped.length, 'tenant_id スコープの無いクエリがある');
});
