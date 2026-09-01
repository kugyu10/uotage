// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import {
  addImportSummary,
  checkImportRowLimit,
  chunkRows,
  EMPTY_IMPORT_SUMMARY,
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_ROWS,
  toImportSummary,
} from "../../src/lib/csv/import-batches.ts";

test("chunkRows は順序を保ったまま size 件ずつに分割し、最後のバッチだけ短くなる", () => {
  assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkRows([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunkRows([1], 5), [[1]]);
});

test("chunkRows は空配列を空のバッチ列にする（RPCを1回も呼ばない）", () => {
  assert.deepEqual(chunkRows([], 500), []);
});

test("chunkRows は全要素をちょうど1回ずつ含む（取りこぼし・重複なし）", () => {
  const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_unused, index) => index);
  const batches = chunkRows(rows, IMPORT_BATCH_SIZE);

  assert.equal(batches.length, Math.ceil(MAX_IMPORT_ROWS / IMPORT_BATCH_SIZE));
  assert.deepEqual(batches.flat(), rows);
  for (const batch of batches) {
    assert.ok(batch.length <= IMPORT_BATCH_SIZE, `バッチが上限を超えている: ${batch.length}`);
  }
});

test("chunkRows は不正な size でも無限ループにせず1バッチにまとめる", () => {
  assert.deepEqual(chunkRows([1, 2, 3], 0), [[1, 2, 3]]);
  assert.deepEqual(chunkRows([1, 2, 3], -1), [[1, 2, 3]]);
  assert.deepEqual(chunkRows([1, 2, 3], Number.NaN), [[1, 2, 3]]);
});

test("chunkRows は元の配列を書き換えない", () => {
  const rows = [1, 2, 3];
  chunkRows(rows, 2);
  assert.deepEqual(rows, [1, 2, 3]);
});

test("addImportSummary は5つの集計値すべてを足し合わせる", () => {
  const first = {
    createdReaders: 1,
    updatedReaders: 2,
    newEnrollments: 3,
    skippedEnrollments: 4,
    deliveriesQueued: 5,
  };
  const second = {
    createdReaders: 10,
    updatedReaders: 20,
    newEnrollments: 30,
    skippedEnrollments: 40,
    deliveriesQueued: 50,
  };
  assert.deepEqual(addImportSummary(first, second), {
    createdReaders: 11,
    updatedReaders: 22,
    newEnrollments: 33,
    skippedEnrollments: 44,
    deliveriesQueued: 55,
  });
  // EMPTY_IMPORT_SUMMARY は加算の単位元（バッチループの初期値として使う）。
  assert.deepEqual(addImportSummary(EMPTY_IMPORT_SUMMARY, first), first);
});

test("バッチごとのサマリを畳み込むと総計になる", () => {
  const perBatch = Array.from({ length: 10 }, () => ({
    createdReaders: 3,
    updatedReaders: 2,
    newEnrollments: 4,
    skippedEnrollments: 1,
    deliveriesQueued: 7,
  }));
  const total = perBatch.reduce(addImportSummary, EMPTY_IMPORT_SUMMARY);
  assert.deepEqual(total, {
    createdReaders: 30,
    updatedReaders: 20,
    newEnrollments: 40,
    skippedEnrollments: 10,
    deliveriesQueued: 70,
  });
});

test("toImportSummary は RPC の snake_case 行を camelCase に写す", () => {
  assert.deepEqual(
    toImportSummary({
      created_readers: 1,
      updated_readers: 2,
      new_enrollments: 3,
      skipped_enrollments: 4,
      deliveries_queued: 5,
    }),
    {
      createdReaders: 1,
      updatedReaders: 2,
      newEnrollments: 3,
      skippedEnrollments: 4,
      deliveriesQueued: 5,
    },
  );
});

test("toImportSummary は欠損・非数値・null を 0 にする（合算がNaNで壊れない）", () => {
  assert.deepEqual(toImportSummary({}), EMPTY_IMPORT_SUMMARY);
  assert.deepEqual(toImportSummary(null), EMPTY_IMPORT_SUMMARY);
  assert.deepEqual(toImportSummary({ created_readers: "abc" }), EMPTY_IMPORT_SUMMARY);
  // PostgREST は bigint を文字列で返すことがあるため、数値化できる文字列は受ける。
  assert.equal(toImportSummary({ created_readers: "12" }).createdReaders, 12);
});

test("checkImportRowLimit は上限以下なら null、超過なら日本語の理由を返す", () => {
  assert.equal(checkImportRowLimit(0, 0), null);
  assert.equal(checkImportRowLimit(MAX_IMPORT_ROWS, 0), null);
  assert.equal(checkImportRowLimit(MAX_IMPORT_ROWS - 1, 1), null);

  const message = checkImportRowLimit(MAX_IMPORT_ROWS, 1);
  assert.ok(message, "上限超過なのに null が返っている");
  assert.match(message, /行数が多すぎます/);
  assert.match(message, /5,001行/);
  assert.match(message, /5,000行まで/);
});

test("checkImportRowLimit は不正行もペイロードに乗るため合計で判定する", () => {
  // 有効行が0でも不正行が上限を超えていれば弾く（invalidRows も RSCペイロードに乗る）。
  assert.notEqual(checkImportRowLimit(0, MAX_IMPORT_ROWS + 1), null);
});
