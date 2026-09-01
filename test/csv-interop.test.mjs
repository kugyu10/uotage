import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// src/lib/csv/*.ts は相対importに拡張子(.ts)を明記しているため、
// `node --test --experimental-strip-types` から直接importできる。
// 以前はここに transpile 用の自前CommonJSローダーを置いていたが、
// 拡張子を明記したことで不要になった（test/unit/*.ts と同じ方式に統一）。
import { parseCsv } from '../src/lib/csv/parse.ts';
import { formatCsvField, sanitizeCsvCell, buildCsv, UTF8_BOM } from '../src/lib/csv/format.ts';
import { formatJstDateTime, jstDatetimeLocalToUtcIso } from '../src/lib/csv/timezone.ts';
import { parseImportCsv } from '../src/lib/csv/import-rows.ts';
import { buildScenarioExportCsv } from '../src/lib/csv/export-rows.ts';

// --- 静的アサーション対象ファイル ---
const importRpcSql = (
  await readFile(new URL('../supabase/migrations/20260819020000_import_scenario_readers.sql', import.meta.url), 'utf8')
).replace(/\s+/g, ' ').toLowerCase();
const exportRoute = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/export/route.ts', import.meta.url),
  'utf8',
);
const importActions = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/import/actions.ts', import.meta.url),
  'utf8',
);
const importWizard = await readFile(
  new URL('../src/app/admin/mail/scenarios/[scenarioId]/import/ImportWizard.tsx', import.meta.url),
  'utf8',
);

// ============================== parseCsv ==============================

test('parseCsv splits plain rows and strips a leading BOM', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
  assert.deepEqual(parseCsv('\uFEFFa,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parseCsv handles quoted fields with embedded commas, newlines, and escaped quotes', () => {
  const input = 'name,note\n"鈴木, 太郎","line1\nline2"\n"say ""hi""",plain\n';
  assert.deepEqual(parseCsv(input), [
    ['name', 'note'],
    ['鈴木, 太郎', 'line1\nline2'],
    ['say "hi"', 'plain'],
  ]);
});

test('parseCsv supports CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

// ============================== format / sanitize ==============================

test('formatCsvField quotes only when necessary and escapes internal quotes', () => {
  assert.equal(formatCsvField('plain'), 'plain');
  assert.equal(formatCsvField('a,b'), '"a,b"');
  assert.equal(formatCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(formatCsvField('line1\nline2'), '"line1\nline2"');
});

test('sanitizeCsvCell neutralizes CSV/formula injection prefixes', () => {
  assert.equal(sanitizeCsvCell('=1+1'), "'=1+1");
  assert.equal(sanitizeCsvCell('+1'), "'+1");
  assert.equal(sanitizeCsvCell('-1'), "'-1");
  assert.equal(sanitizeCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(sanitizeCsvCell('普通の名前'), '普通の名前');
  assert.equal(sanitizeCsvCell(''), '');
});

test('buildCsv joins rows with CRLF and a trailing CRLF', () => {
  assert.equal(buildCsv(['a', 'b'], [['1', '2']]), 'a,b\r\n1,2\r\n');
});

test('UTF8_BOM is the single BOM code point', () => {
  assert.equal(UTF8_BOM, '\uFEFF');
});

// ============================== timezone ==============================

test('formatJstDateTime renders Asia/Tokyo wall-clock time (UTC+9)', () => {
  assert.equal(formatJstDateTime('2026-01-01T00:00:00Z'), '2026-01-01 09:00:00');
  assert.equal(formatJstDateTime('2026-08-19T15:30:45Z'), '2026-08-20 00:30:45');
});

test('jstDatetimeLocalToUtcIso interprets a datetime-local value as JST wall time', () => {
  assert.equal(jstDatetimeLocalToUtcIso('2026-01-01T09:00'), '2026-01-01T00:00:00.000Z');
  assert.throws(() => jstDatetimeLocalToUtcIso('not-a-date'));
});

// ============================== parseImportCsv (10.2) ==============================

test('parseImportCsv routes unknown columns into custom_fields and known columns into structured fields', () => {
  const csv = [
    'メールアドレス,名前,登録日時,登録経路,ラベル,購入状況,解除状況,好きな色',
    'Reader@Example.com,鈴木,2026-01-01 00:00:00,lp-a,"見込み客, VIP",商品A,,青',
  ].join('\n');
  const parsed = parseImportCsv(csv);
  assert.equal(parsed.invalidRows.length, 0);
  assert.equal(parsed.rows.length, 1);
  const [row] = parsed.rows;
  assert.equal(row.email, 'reader@example.com');
  assert.equal(row.name, '鈴木');
  assert.equal(row.registrationPath, 'lp-a');
  assert.deepEqual(row.labels, ['見込み客', 'VIP']);
  assert.deepEqual(row.customFields, { 好きな色: '青' });
  assert.deepEqual(parsed.labels, ['見込み客', 'VIP']);
});

test('parseImportCsv flags missing/invalid/duplicate emails as invalid rows instead of throwing', () => {
  const csv = [
    'メールアドレス,名前',
    ',空メール',
    'not-an-email,不正',
    'ok@example.com,一人目',
    'OK@Example.com,二人目（重複）',
  ].join('\n');
  const parsed = parseImportCsv(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].email, 'ok@example.com');
  assert.equal(parsed.invalidRows.length, 3);
});

test('parseImportCsv requires a メールアドレス header', () => {
  assert.throws(() => parseImportCsv('名前,年齢\n太郎,20\n'), /MISSING_EMAIL_HEADER/);
});

// ============================== buildScenarioExportCsv (10.1) ==============================

test('buildScenarioExportCsv is BOM-prefixed with Japanese headers and per-scenario custom_fields columns', () => {
  const csv = buildScenarioExportCsv([
    {
      email: 'reader@example.com',
      name: '鈴木',
      registeredAt: '2026-01-01T00:00:00Z',
      registrationPath: 'lp-a',
      labels: ['見込み客', 'VIP'],
      purchasedProducts: ['商品A', '商品B'],
      unsubscribed: false,
      customFields: { 好きな色: '青' },
    },
  ]);
  assert.ok(csv.startsWith('\uFEFF'));
  const withoutBom = csv.slice(1);
  const [headerLine, dataLine] = withoutBom.split('\r\n');
  assert.equal(headerLine, 'メールアドレス,名前,登録日時,登録経路,ラベル,購入状況,解除状況,好きな色');
  assert.equal(dataLine, 'reader@example.com,鈴木,2026-01-01 09:00:00,lp-a,"見込み客,VIP","商品A,商品B",,青');
});

test('buildScenarioExportCsv marks unsubscribed readers and sanitizes CSV-injection-looking cells', () => {
  const csv = buildScenarioExportCsv([
    {
      email: 'reader2@example.com',
      name: '=cmd|calc',
      registeredAt: '2026-01-01T00:00:00Z',
      registrationPath: null,
      labels: [],
      purchasedProducts: [],
      unsubscribed: true,
      customFields: {},
    },
  ]);
  const [, dataLine] = csv.slice(1).split('\r\n');
  assert.match(dataLine, /'=cmd\|calc/);
  assert.match(dataLine, /解除済み/);
});

// ============================== SQL RPC: 10.2 事故防止要件の静的アサーション ==============================

test('import_scenario_readers is a SECURITY DEFINER RPC restricted to service_role, like register_reader', () => {
  assert.match(importRpcSql, /security definer/);
  assert.match(importRpcSql, /set search_path = ''/);
  assert.match(
    importRpcSql,
    /revoke all on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, jsonb\) from public/,
  );
  assert.match(
    importRpcSql,
    /grant execute on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, jsonb\) to service_role/,
  );
});

test('import_scenario_readers scopes every table access by tenant_id', () => {
  assert.match(importRpcSql, /where tenant_id = target_tenant_id and id = target_scenario_id/);
  assert.match(importRpcSql, /where tenant_id = target_tenant_id and email = lower\(row_data->>'email'\)/);
  assert.match(importRpcSql, /values \(target_tenant_id, trimmed_label\)/);
  assert.match(
    importRpcSql,
    /where step\.tenant_id = target_tenant_id and step\.scenario_id = target_scenario_id/,
  );
});

test('import_scenario_readers implements all three resend-prevention options', () => {
  assert.match(importRpcSql, /delivery_mode not in \('none', 'from_now', 'from_start'\)/);
  assert.match(importRpcSql, /if delivery_mode = 'from_now' then computed_registered_at := target_registered_at;/);
  assert.match(importRpcSql, /if delivery_mode <> 'none' then/);
  assert.match(importRpcSql, /where delivery_mode = 'from_start' or steps\.computed_scheduled_at > execution_time/);
});

test('import_scenario_readers is idempotent via ON CONFLICT DO NOTHING on every write path', () => {
  assert.match(importRpcSql, /on conflict \(tenant_id, name\) do nothing/); // labels
  assert.match(importRpcSql, /on conflict \(reader_id, label_id\) do nothing/); // reader_labels
  assert.match(importRpcSql, /on conflict \(reader_id, scenario_id\) do nothing/); // scenario_readers
  assert.match(importRpcSql, /on conflict \(scenario_reader_id, step_message_id\) do nothing/); // deliveries
  // 既に登録済みの読者はスキップし、期限をリセットしない（deliveriesも積まない）。
  assert.match(importRpcSql, /if enrollment\.id is null then/);
  assert.match(importRpcSql, /skipped_enrollment_count := skipped_enrollment_count \+ 1;/);
});

test('import_scenario_readers falls back to registered_at when the scenario has no funnel (deadline_hours)', () => {
  assert.match(importRpcSql, /if selected_funnel\.id is not null then computed_deadline_at := computed_registered_at \+ make_interval\(hours => selected_funnel\.deadline_hours\); else computed_deadline_at := computed_registered_at; end if;/);
});

// ============================== export route: 10.1 要件の静的アサーション ==============================

test('scenario export route requires an operator, scopes by tenant_id, and streams a BOM-prefixed CSV download', () => {
  assert.match(exportRoute, /requireOperator/);
  assert.match(exportRoute, /\.eq\("tenant_id", operator\.tenant_id\)/);
  assert.match(exportRoute, /buildScenarioExportCsv/);
  assert.match(exportRoute, /"Content-Type": "text\/csv; charset=utf-8"/);
  assert.match(exportRoute, /filename\*=UTF-8''/);
});

// ============================== import actions: 10.2 事故防止要件の静的アサーション ==============================

test('previewImport never writes to the database (dry run only)', () => {
  const previewFn = importActions.slice(
    importActions.indexOf('export async function previewImport'),
    importActions.indexOf('export interface ConfirmState'),
  );
  assert.doesNotMatch(previewFn, /\.rpc\(/);
  assert.doesNotMatch(previewFn, /createAdminClient/);
  assert.match(previewFn, /parseImportCsv/);
});

test('confirmImport requires operator auth, scopes by tenant_id, and delegates the write to the SECURITY DEFINER RPC', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  assert.match(confirmFn, /requireOperator/);
  assert.match(confirmFn, /\.eq\("tenant_id", operator\.tenant_id\)/);
  assert.match(confirmFn, /createAdminClient/);
  assert.match(confirmFn, /admin\.rpc\("import_scenario_readers"/);
  assert.match(confirmFn, /createUrlToken/);
});

test('confirmImport supports exactly the three resend-prevention delivery modes, defaulting safely to "none"', () => {
  assert.match(importActions, /deliveryModeRaw === "from_now" \|\| deliveryModeRaw === "from_start" \? deliveryModeRaw : "none"/);
});

// ============================== import UI: ドライラン必須の静的アサーション ==============================

test('the confirm/execute form only renders after a successful dry run, and defaults to the safest option', () => {
  assert.match(importWizard, /previewState\.status === "ready"/);
  const confirmFormSection = importWizard.slice(
    importWizard.indexOf('previewState.status === "ready"'),
    importWizard.lastIndexOf('</div>'),
  );
  assert.match(confirmFormSection, /<form action=\{confirmAction\}>/);
  assert.match(importWizard, /useState<DeliveryMode>\("none"\)/);
  assert.match(importWizard, /value="none"/);
  assert.match(importWizard, /value="from_now"/);
  assert.match(importWizard, /value="from_start"/);
});
