// issue #2: 確定実行はファイルを再パースし、ドライラン済みファイルとの同一性を
// ハッシュで照合する。ここは「構造の照合」ではなく、FormData を直接渡して
// readConfirmedImportFile の**挙動**を固定するテスト（レビュー指摘 🟡2 の宿題）。
// confirmImport 本体は requireOperator / createAdminClient を先に通るため単体で呼べないが、
// ドライラン必須・差し替え検知という issue #2 の受け入れ条件はこの関数に閉じている。
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeImportCsv,
  hashImportCsvBytes,
  MAX_IMPORT_FILE_SIZE_BYTES,
  readConfirmedImportFile,
} from "../../src/lib/csv/import-file.ts";

const CSV = "メールアドレス,名前\nuser@example.com,テスト\n";

function csvFile(text: string, name = "readers.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

function hashOf(text: string): string {
  return hashImportCsvBytes(new TextEncoder().encode(text));
}

function formDataWith(file: File | null): FormData {
  const formData = new FormData();
  if (file) formData.set("file", file);
  formData.set("deliveryMode", "none");
  return formData;
}

test("hashImportCsvBytes は同じバイト列に対して常に同じ値を返す（決定性）", () => {
  const bytes = new TextEncoder().encode(CSV);
  assert.equal(hashImportCsvBytes(bytes), hashImportCsvBytes(bytes));
  // sha256 hex（64桁）であること。形式が変わると bind で往復する値の互換が壊れる。
  assert.match(hashImportCsvBytes(bytes), /^[0-9a-f]{64}$/);
});

test("hashImportCsvBytes は1文字の差でも別の値になる（差し替え検知）", () => {
  assert.notEqual(hashOf("メールアドレス\nuser@example.com\n"), hashOf("メールアドレス\nuser@example.org\n"));
});

test("hashImportCsvBytes はデコードすると同じになる別バイト列を区別する（バイト単位のハッシュ）", () => {
  // 不正な UTF-8 バイト列はデコードすると両方 U+FFFD に潰れる。文字列をハッシュしていると
  // 「中身の違うファイルが同じハッシュ」になるため、生バイト列で判定していることを固定する。
  const invalidA = new Uint8Array([0xe3, 0x81]); // 途中で切れた3バイト文字
  const invalidB = new Uint8Array([0xe3, 0x82]);
  assert.equal(decodeImportCsv(invalidA), decodeImportCsv(invalidB));
  assert.notEqual(hashImportCsvBytes(invalidA), hashImportCsvBytes(invalidB));
});

test("readConfirmedImportFile はドライラン未実行（ハッシュ未発行）なら取り込まない", async () => {
  const result = await readConfirmedImportFile(formDataWith(csvFile(CSV)), undefined);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "先にドライランを実行してください。");
});

test("readConfirmedImportFile はファイル未添付・空ファイルなら取り込まない", async () => {
  const missing = await readConfirmedImportFile(formDataWith(null), hashOf(CSV));
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.error : "", /CSVファイルを選択して/);

  const empty = await readConfirmedImportFile(formDataWith(csvFile("")), hashOf(CSV));
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.error : "", /CSVファイルを選択して/);
});

test("readConfirmedImportFile は上限超過のファイルを、ハッシュが一致していても取り込まない", async () => {
  const huge = "a".repeat(MAX_IMPORT_FILE_SIZE_BYTES + 1);
  const result = await readConfirmedImportFile(formDataWith(csvFile(huge)), hashOf(huge));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /ファイルサイズが大きすぎます/);
});

test("readConfirmedImportFile はドライラン後に差し替えられたファイルを弾く", async () => {
  const tampered = CSV.replace("user@example.com", "attacker@example.com");
  const result = await readConfirmedImportFile(formDataWith(csvFile(tampered)), hashOf(CSV));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /ドライラン後にファイルが変更されています/);
});

test("readConfirmedImportFile はドライランと同一のファイルならパース対象のテキストを返す", async () => {
  const result = await readConfirmedImportFile(formDataWith(csvFile(CSV)), hashOf(CSV));
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.text, CSV);
});

test("readConfirmedImportFile はファイル名が違っても中身が同じなら通す（判定対象は中身）", async () => {
  const result = await readConfirmedImportFile(formDataWith(csvFile(CSV, "renamed.csv")), hashOf(CSV));
  assert.equal(result.ok, true);
});
