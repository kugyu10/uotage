// コードレビュー指摘（高）: CSVインポートの行数上限とバッチ分割、CSVエクスポートの件数上限。
//
// 分割・合算・ページングそのものの振る舞いは実装を import して検証している
// （test/unit/csv-import-batches.test.ts / test/unit/supabase-paginate.test.ts）。
// ここでは import できないもの（SQL関数、"use server" の Server Action、Route Handler）
// について、配線が外れていないことだけをパターンで確認する。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { IMPORT_BATCH_SIZE, MAX_IMPORT_ROWS } from '../src/lib/csv/import-batches.ts';
import { SUPABASE_PAGE_SIZE } from '../src/lib/supabase/paginate.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const batchLimitSql = (await read('../supabase/migrations/20260902010000_import_batch_row_limit.sql'))
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
  // 引数が1つ増えた（target_executed_at）ので、drop も revoke/grant も新旧の
  // シグネチャが噛み合っていること。片方を直し忘れると権限が付かない関数が残る。
  assert.match(batchLimitSql, /drop function if exists public\.import_scenario_readers\(uuid, uuid, text, timestamptz, jsonb\)/);
  assert.match(
    batchLimitSql,
    /revoke all on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, timestamptz, jsonb\) from public/,
  );
  assert.match(
    batchLimitSql,
    /grant execute on function public\.import_scenario_readers\(uuid, uuid, text, timestamptz, timestamptz, jsonb\) to service_role/,
  );
  // 冪等性の担保（再実行して二重登録しない）は行数ガード追加後も残っていること。
  assert.match(batchLimitSql, /on conflict \(reader_id, scenario_id\) do nothing/);
  assert.match(batchLimitSql, /on conflict \(scenario_reader_id, step_message_id\) do nothing/);
});

const previewFn = importActions.slice(
  importActions.indexOf('export async function previewImport'),
  importActions.indexOf('export interface ConfirmState'),
);

test('previewImport は行数上限を判定し、依然としてDBへ書き込まない', () => {
  assert.match(previewFn, /checkImportRowLimit\(parsed\.rows\.length, parsed\.invalidRows\.length\)/);
  assert.doesNotMatch(previewFn, /\.rpc\(/);
  assert.doesNotMatch(previewFn, /createAdminClient/);
});

test('previewImport は .in() を全件渡さずチャンク化し、labels もページングする', () => {
  // 5,000件を .in() に渡すと約160〜195KBで URI長制限に当たり、上限行数に到達できない。
  assert.match(previewFn, /fetchInChunks<string, \{ id: string; email: string \}>/);
  assert.match(previewFn, /fetchInChunks<string, \{ reader_id: string \}>/);
  assert.match(previewFn, /\.in\("email", chunk\)/);
  assert.match(previewFn, /\.in\("reader_id", chunk\)/);
  // 生の配列を .in() に渡す実装に戻っていないこと。
  assert.doesNotMatch(previewFn, /\.in\("email", emails\)/);
  assert.doesNotMatch(previewFn, /\.in\("reader_id", existingReaderIds\)/);
  // labels もページングする（打ち切られると既存ラベルが「新規ラベル」に見える）。
  assert.match(previewFn, /fetchAllPages<\{ id: string; name: string \}>/);
});

test('previewImport はクエリのエラーを握り潰さず、件数を捏造しない', () => {
  // `data ?? []` で受けると 414 が「該当0件」と区別できず、既存読者が全員新規に見える。
  assert.doesNotMatch(previewFn, /\?\? \[\]\)\.map/);
  assert.match(previewFn, /status: "error"/);
  assert.match(previewFn, /既存読者の照合に失敗しました/);
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

test('confirmImport は検証済み行を受け取らず、ファイルを再パースする (issue #2)', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  // 確定実行のリクエストに含まれたファイルをサーバーで読み直し、パースと行数上限を再適用する。
  assert.match(confirmFn, /readConfirmedImportFile\(formData, expectedFileHash\)/);
  assert.match(confirmFn, /parseImportCsv\(text\)/);
  assert.match(confirmFn, /checkImportRowLimit\(parsed\.rows\.length, parsed\.invalidRows\.length\)/);
  // 再パース結果は「全行」を取り込む。slice やページングが混ざると
  // 「5,000行のつもりが一部しか入らない」という静かなデータ欠落になる（レビュー指摘 🟢1）。
  assert.match(confirmFn, /const rowsPayload = parsed\.rows\.map\(/);
  // ハッシュ一致＝ドライランと同一テキストなので実質到達しないが、0行で RPC を叩かない
  // 防御的ガードを残しておく（レビュー指摘 🟢2）。
  assert.match(confirmFn, /if \(parsed\.rows\.length === 0\)/);
  // 検証済み行の配列をクライアント経由で受ける実装（RSCペイロード往復）に戻っていないこと。
  // （\b が無いと invalidRows に部分一致してしまう）
  // 対象はファイル全体ではなく「往復が起きうる箇所」に絞る。無関係な文脈で validRows という
  // 識別子を使っただけで落ちるのは、このテストの意図とずれるため（レビュー指摘 🟢6）。
  const previewStateInterface = importActions.slice(
    importActions.indexOf('export interface PreviewState'),
    importActions.indexOf('export const initialPreviewState'),
  );
  assert.ok(previewStateInterface.length > 0, 'PreviewState の定義が見つからない');
  assert.doesNotMatch(previewStateInterface, /\bvalidRows\b/);
  assert.doesNotMatch(confirmFn, /\bvalidRows\b/);
  assert.doesNotMatch(importWizard, /confirmImport\.bind\([^)]*\bvalidRows\b/);
});

test('確定実行はドライラン済みファイルとの同一性をハッシュで検証する (issue #2)', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  // ドライランがハッシュを発行し、確定実行は readConfirmedImportFile がパースより先に照合する
  // （照合そのものの挙動は test/unit/csv-import-file.test.ts が実物を呼んで固定している）。
  assert.match(previewFn, /fileHash: hashImportCsvBytes\(bytes\)/);
  // デコードは preview / confirm とも decodeImportCsv の1本だけ。片方が file.text() などに
  // 戻ると「ハッシュは一致するのにパース結果が違う」壊れ方をする（レビュー指摘 🟢3）。
  assert.match(previewFn, /const text = decodeImportCsv\(bytes\)/);
  assert.match(confirmFn, /readConfirmedImportFile\(formData, expectedFileHash\)/);
  assert.match(confirmFn, /if \(!confirmedFile\.ok\)/);
  // ウィザードが bind で戻すのはハッシュだけ（bind 引数は暗号化されるため改竄できない）。
  assert.match(importWizard, /confirmImport\.bind\(null, scenarioId, previewState\.fileHash\)/);
  // React 19 は action 付き form の送信後に form.reset() を走らせ file input が空になるため、
  // 確定実行は state に保持した File を FormData へ詰め直して送る（レビュー指摘の対応）。
  // 注意: ここは構造（配線）の検証のみ。実際にファイルがリクエストへ乗るかはブラウザ挙動に
  // 依存するため、実ブラウザでの確認は UAT (#13) に積んである。
  assert.match(importWizard, /formData\.set\("file", file\)/);
  assert.match(importWizard, /confirmAction\(formData\)/);
  const fileInputs = importWizard.match(/type="file"/g) ?? [];
  assert.equal(fileInputs.length, 1, 'file input が複数あると再送されるファイルが曖昧になる');
});

test('ファイルサイズ上限の文言は定数と同じ場所に1つだけ置く (issue #2 レビュー 🟢4)', () => {
  // 上限値 (MAX_IMPORT_FILE_SIZE_BYTES) と「5MB以下にしてください」という文言が
  // 別ファイルに分かれると、片方だけ変えたときに嘘の案内になる。
  // preview / confirm とも import-file.ts の共有定数を使い、actions.ts には直書きしない。
  assert.match(previewFn, /error: IMPORT_FILE_TOO_LARGE_ERROR/);
  assert.doesNotMatch(importActions, /"ファイルサイズが大きすぎます/);
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

/**
 * ソース中の `name(...)` / `name<...>(...)` 呼び出しを括弧の対応で切り出し、
 * 呼び出しごとのトップレベル引数（文字列）の配列を返す。
 *
 * `/^\s*foo,$/m` のような行単位の正規表現だと「引数が1行1個」の整形に依存し、
 * 引数を1行に畳んだだけでコードが正しくてもテストが落ちる。ここは括弧の対応を数えるので
 * 改行位置に依存しない。文字列リテラル内のカンマ（`.select("id, email")`）も無視する。
 */
function callArguments(source, name) {
  const calls = [];
  const needle = new RegExp(`\\b${name}\\b`, 'g');
  let match;
  while ((match = needle.exec(source)) !== null) {
    // import 文や日本語コメント中の同名は拾わない。呼び出しなら直後は `<`（型引数）か `(`。
    const rest = source.slice(match.index + name.length);
    if (!/^\s*[<(]/.test(rest)) continue;
    // 型引数 `<...>` にはカッコが出てこないので、呼び出し名の後の最初の `(` が引数リストの開き。
    const open = source.indexOf('(', match.index);
    if (open < 0) break;
    const args = [];
    let depth = 0;
    let current = '';
    let quote = '';
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        current += char;
        if (char === '\\') {
          current += source[i + 1] ?? '';
          i += 1;
        } else if (char === quote) {
          quote = '';
        }
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        current += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') {
        depth += 1;
        if (depth === 1) continue; // 引数リストの開きカッコ自体は本文に含めない
      } else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          if (current.trim()) args.push(current.trim());
          break;
        }
      } else if (char === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    calls.push(args);
  }
  return calls;
}

test('エクスポートは fetchInChunks の並列度を 1 に固定し、同時リクエストを倍増させない', () => {
  // issue #6 で fetchInChunks 内が並列化された。エクスポートは Promise.all で
  // fetchInChunks を3本同時に走らせているので、既定の並列度のままだと同時リクエストが
  // 3 × SUPABASE_CHUNK_CONCURRENCY へ倍増し、共有コネクションプールを想定外に食う。
  // レイテンシ改善の対象は取り込みのドライラン側なので、ここは従来どおり「同時3本」に固定する。
  assert.match(exportRoute, /const exportChunkConcurrency = 1;/);
  const calls = callArguments(exportRoute, 'fetchInChunks');
  assert.ok(calls.length > 0, 'エクスポートが fetchInChunks を使わなくなっている');
  for (const args of calls) {
    // issue #5 で調整用引数はオプションオブジェクトになったので
    // (keys, fetchChunkPage, { chunkSize, pageSize, maxRows, concurrency }) の3引数。
    assert.equal(args.length, 3, `fetchInChunks の引数が3つでない: ${args.length}個`);
    assert.match(
      args[2],
      /concurrency:\s*exportChunkConcurrency\b/,
      `並列度を渡していない fetchInChunks がある（第3引数: ${args[2]}）`,
    );
  }
});

test('取り込みのドライランは fetchInChunks の並列度を明示せず、既定値に乗る', () => {
  // issue #6 の本題は previewImport のレイテンシ。ここで並列度を明示してしまうと、
  // SUPABASE_CHUNK_CONCURRENCY を調整しても取り込み側に効かなくなる（＝直列に戻せてしまう）。
  // エクスポート側だけ配線テストがある非対称を解消する。
  const calls = callArguments(previewFn, 'fetchInChunks');
  assert.equal(calls.length, 2, 'ドライランの fetchInChunks は readers と scenario_readers の2本');
  for (const args of calls) {
    assert.equal(
      args.length,
      2,
      `ドライランの fetchInChunks が並列度などを明示している（引数${args.length}個）: ${args.slice(2).join(' / ')}`,
    );
  }
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

test('実行時刻は全バッチで同じ値を渡し、時間軸が1本になっている', () => {
  const confirmFn = importActions.slice(importActions.indexOf('export async function confirmImport'));
  // アプリ側で1つの時刻を決めて全バッチへ渡す。
  assert.match(confirmFn, /const executedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(confirmFn, /target_executed_at: executedAt,/);
  // RPC 側は渡された時刻を優先し、未指定なら従来どおり now() に落ちる。
  assert.match(batchLimitSql, /execution_time timestamptz := coalesce\(target_executed_at, now\(\)\)/);
  // now() をバッチごとに取り直す実装に戻っていないこと。
  assert.doesNotMatch(batchLimitSql, /execution_time timestamptz := now\(\);/);
  // 'from_now' の必須チェックは残っていること。
  assert.match(batchLimitSql, /target_registered_at is required for delivery_mode = from_now/);
});

test('deliveries の絞り込み基準は registered_at ではなく共有された実行時刻', () => {
  // 'from_now' は過去日を指定しうる。target_registered_at を基準にすると
  // 既に予定日を過ぎたステップまで一斉送信されるため、execution_time のままにする。
  assert.match(batchLimitSql, /where delivery_mode = 'from_start' or steps\.computed_scheduled_at > execution_time/);
  assert.doesNotMatch(batchLimitSql, /computed_scheduled_at > target_registered_at/);
});

test('previewImport は照合の失敗をログに残す（原因を追えるようにする）', () => {
  // `catch {}` だとオペレーターの報告だけが残り、414・timeout・権限の区別がつかない。
  assert.match(previewFn, /\} catch \(error\) \{/);
  assert.match(previewFn, /console\.error\("\[csv-import\] 既存読者の照合に失敗"/);
  assert.doesNotMatch(previewFn, /\} catch \{/);
});

test('fetchAllPages / fetchInChunks の order は一意なキーで行っている', () => {
  // fetchAllPages の契約: 順序が安定しないページングは行の重複・欠落を生む。
  // labels は unique (tenant_id, name) があるが、契約どおり id で order する。
  assert.match(previewFn, /\.from\("labels"\)[\s\S]{0,160}?\.order\("id"\)/);
  assert.match(exportRoute, /\.from\("labels"\)[\s\S]{0,160}?\.order\("id"\)/);
  assert.doesNotMatch(previewFn, /\.from\("labels"\)[\s\S]{0,160}?\.order\("name"\)/);
});

test('マイグレーションのバージョン（先頭14桁）が重複していない', async () => {
  // Supabase CLI は先頭14桁をバージョンとして記録するため、重複すると
  // db push で片方がスキップ/失敗し、適用順も保証されない。
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((name) =>
    name.endsWith('.sql'),
  );
  const versions = files.map((name) => name.slice(0, 14));
  const duplicated = versions.filter((version, index) => versions.indexOf(version) !== index);
  assert.deepEqual(duplicated, [], `バージョンが重複している: ${duplicated.join(', ')}`);
  // 14桁がすべて数字であること（命名規約から外れたファイルを検知する）。
  for (const version of versions) {
    assert.match(version, /^\d{14}$/);
  }
});

test('行数ガードの migration は、それ以前に存在していた migration より後のバージョンになっている', async () => {
  // #9 での修正: 「その時点の最新」を動的に見て比較すると、後から別件の migration が
  // 増えるたびにこのテストが壊れる（このテスト自身は行数ガード導入時の順序退行の
  // 回帰確認であり、以降に追加される無関係な migration の存在に依存すべきではない）。
  // そのため比較対象は「行数ガード migration より前のバージョン番号を持つもの」に固定する。
  const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((name) =>
    name.endsWith('.sql'),
  );
  const target = files.find((name) => name.includes('import_batch_row_limit'));
  assert.ok(target, 'import_batch_row_limit の migration が見つからない');
  const targetVersion = target.slice(0, 14);
  const priorOthers = files
    .filter((name) => name !== target)
    .map((name) => name.slice(0, 14))
    .filter((version) => version < targetVersion);
  const latestPrior = priorOthers.sort().at(-1);
  assert.ok(
    targetVersion > latestPrior,
    `${target} が導入当時の最新(${latestPrior})より前に適用される`,
  );
});
