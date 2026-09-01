import assert from "node:assert/strict";
import test from "node:test";

import { buildCsv, formatCsvField, sanitizeCsvCell, UTF8_BOM } from "../../src/lib/csv/format.ts";

test("カンマ・引用符・改行を含むセルだけを引用符で囲む", () => {
  assert.equal(formatCsvField("plain"), "plain");
  assert.equal(formatCsvField("x,y"), '"x,y"');
  assert.equal(formatCsvField('he said "hi"'), '"he said ""hi"""');
  assert.equal(formatCsvField("1\r\n2"), '"1\r\n2"');
});

test("数式として解釈されうる先頭文字にシングルクォートを付与する", () => {
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(sanitizeCsvCell(`${prefix}cmd`), `'${prefix}cmd`, `prefix=${JSON.stringify(prefix)}`);
  }
});

test("数式でないセルはそのまま返す", () => {
  assert.equal(sanitizeCsvCell("山田太郎"), "山田太郎");
  assert.equal(sanitizeCsvCell("a=b"), "a=b");
  assert.equal(sanitizeCsvCell(""), "");
});

test("CRLF 区切りで組み立て、末尾にも CRLF を付ける", () => {
  assert.equal(buildCsv(["a", "b"], [["1", "2"]]), "a,b\r\n1,2\r\n");
});

test("UTF8_BOM は Excel が認識する単一の U+FEFF", () => {
  assert.equal(UTF8_BOM, "﻿");
  assert.equal(UTF8_BOM.length, 1);
});
