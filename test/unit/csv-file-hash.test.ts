// issue #2: 確定実行はファイルを再パースし、ドライラン済みファイルとの同一性を
// このハッシュで照合する。挙動が変わると「表示された件数と違う内容の取り込み」を
// 見逃すため、決定性と衝突（別内容が同じハッシュにならないこと）を最低限固定する。
import assert from "node:assert/strict";
import test from "node:test";

import { hashImportCsvText } from "../../src/lib/csv/file-hash.ts";

test("hashImportCsvText は同じテキストに対して常に同じ値を返す（決定性）", () => {
  const text = "メールアドレス,名前\nuser@example.com,テスト\n";
  assert.equal(hashImportCsvText(text), hashImportCsvText(text));
  // sha256 hex（64桁）であること。形式が変わると bind で往復する値の互換が壊れる。
  assert.match(hashImportCsvText(text), /^[0-9a-f]{64}$/);
});

test("hashImportCsvText は1文字の差でも別の値になる（差し替え検知）", () => {
  const original = "メールアドレス\nuser@example.com\n";
  const tampered = "メールアドレス\nuser@example.org\n";
  assert.notEqual(hashImportCsvText(original), hashImportCsvText(tampered));
});
