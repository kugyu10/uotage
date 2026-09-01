// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
//
// エクスポート（10.1）→ インポート（10.2）の往復がCSV移行の中核なので、
// 2つのモジュールを実際に繋いで「出したものが読み戻せる」ことを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import { buildScenarioExportCsv, type ExportReaderRow } from "../../src/lib/csv/export-rows.ts";
import { parseImportCsv } from "../../src/lib/csv/import-rows.ts";
import { UTF8_BOM } from "../../src/lib/csv/format.ts";

const baseRow: ExportReaderRow = {
  email: "taro@example.com",
  name: "山田 太郎",
  registeredAt: "2026-08-19T00:30:00.000Z",
  registrationPath: "/lp/sample",
  labels: ["見込み客", "セミナー参加"],
  purchasedProducts: [],
  unsubscribed: false,
  customFields: { 会社名: "テスト株式会社", 電話番号: "03-0000-0000" },
};

test("エクスポートしたCSVをそのままインポートすると読者情報が復元できる", () => {
  const csv = buildScenarioExportCsv([baseRow]);
  const parsed = parseImportCsv(csv);

  assert.deepEqual(parsed.invalidRows, []);
  assert.equal(parsed.rows.length, 1);

  const row = parsed.rows[0];
  assert.equal(row.email, baseRow.email);
  assert.equal(row.name, baseRow.name);
  assert.equal(row.registrationPath, baseRow.registrationPath);
  assert.deepEqual(row.labels, baseRow.labels);
  assert.deepEqual(row.customFields, baseRow.customFields);
  assert.equal(row.unsubscribed, false);
});

test("エクスポートCSVは先頭にBOMを持ち、インポート側がそれを剥がせる", () => {
  const csv = buildScenarioExportCsv([baseRow]);
  assert.ok(csv.startsWith(UTF8_BOM), "BOMが付いていない");
  // BOMが剥がれていないと1列目のヘッダー名が一致せずメールアドレス列を見つけられない。
  assert.equal(parseImportCsv(csv).rows[0].email, baseRow.email);
});

test("解除状況が往復で保たれる（解除済み読者に再送しないための必須条件）", () => {
  const unsubscribed = parseImportCsv(buildScenarioExportCsv([{ ...baseRow, unsubscribed: true }]));
  assert.equal(unsubscribed.rows[0].unsubscribed, true);

  const active = parseImportCsv(buildScenarioExportCsv([{ ...baseRow, unsubscribed: false }]));
  assert.equal(active.rows[0].unsubscribed, false);
});

test("固定カラム（登録日時・購入状況）はインポート側でカスタム項目に混入しない", () => {
  const csv = buildScenarioExportCsv([{ ...baseRow, purchasedProducts: ["有料コース"] }]);
  const row = parseImportCsv(csv).rows[0];
  assert.deepEqual(Object.keys(row.customFields).sort(), ["会社名", "電話番号"]);
  assert.ok(!("登録日時" in row.customFields));
  assert.ok(!("購入状況" in row.customFields));
});

test("カンマ・改行・引用符を含む値が往復で壊れない", () => {
  const tricky: ExportReaderRow = {
    ...baseRow,
    name: '鈴木, "花子"\n二行目',
    registrationPath: "/lp/a,b",
    labels: ["ラベルA", "ラベルB"],
    customFields: { 備考: 'カンマ, と "引用符" と\r\n改行' },
  };
  const row = parseImportCsv(buildScenarioExportCsv([tricky])).rows[0];
  assert.equal(row.name, tricky.name);
  assert.equal(row.registrationPath, tricky.registrationPath);
  // ラベル列はカンマ区切りなので、ラベル名自体にカンマが無ければ分解して復元できる。
  assert.deepEqual(row.labels, tricky.labels);
  assert.equal(row.customFields["備考"], 'カンマ, と "引用符" と\r\n改行');
});

test("複数読者のカスタム項目はヘッダーで和集合になり、持たない読者は空になる", () => {
  const csv = buildScenarioExportCsv([
    { ...baseRow, email: "a@example.com", customFields: { 会社名: "A社" } },
    { ...baseRow, email: "b@example.com", customFields: { 役職: "部長" } },
  ]);
  const parsed = parseImportCsv(csv);
  const byEmail = new Map(parsed.rows.map((row) => [row.email, row]));

  assert.deepEqual(byEmail.get("a@example.com")?.customFields, { 会社名: "A社" });
  assert.deepEqual(byEmail.get("b@example.com")?.customFields, { 役職: "部長" });
});

test("CSVインジェクション対策の '『 は往復で値に残る（数式として実行されない代わりに値が変わる）", () => {
  // sanitizeCsvCell が先頭に ' を付けるため、往復は完全に無損失ではない。
  // これは意図した仕様なので、往復でどう見えるかをテストで固定する。
  const csv = buildScenarioExportCsv([{ ...baseRow, name: "=cmd|calc", customFields: { 備考: "@SUM(1)" } }]);
  const row = parseImportCsv(csv).rows[0];
  assert.equal(row.name, "'=cmd|calc");
  assert.equal(row.customFields["備考"], "'@SUM(1)");
});

test("読者0件でもヘッダーだけのCSVになり、インポートは不正行なしの0行として読む", () => {
  const csv = buildScenarioExportCsv([]);
  const parsed = parseImportCsv(csv);
  assert.deepEqual(parsed.rows, []);
  assert.deepEqual(parsed.invalidRows, []);
  assert.deepEqual(parsed.labels, []);
});

test("往復で参照されたラベル名が出現順に列挙される（自動作成対象の判定に使う）", () => {
  const csv = buildScenarioExportCsv([
    { ...baseRow, email: "a@example.com", labels: ["Z", "A"] },
    { ...baseRow, email: "b@example.com", labels: ["A", "M"] },
  ]);
  assert.deepEqual(parseImportCsv(csv).labels, ["Z", "A", "M"]);
});
