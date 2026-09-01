// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import { parseCsv } from "../../src/lib/csv/parse.ts";

test("CRLF と LF のどちらの改行でも同じ表になる", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("引用符で囲んだセル内のカンマ・改行・二重引用符を復元する", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x,y","1\r\n2"'), [["a", "b"], ["x,y", "1\r\n2"]]);
  assert.deepEqual(parseCsv('a\r\n"he said ""hi"""'), [["a"], ['he said "hi"']]);
});

test("末尾の改行で空行を作らない", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("区切り文字を含まない空行だけの行は取り込まない", () => {
  assert.deepEqual(parseCsv("a,b\r\n\r\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("空セルは空文字列として保持する（列がずれない）", () => {
  assert.deepEqual(parseCsv("a,b,c\r\n1,,3"), [["a", "b", "c"], ["1", "", "3"]]);
  assert.deepEqual(parseCsv("a,b\r\n,"), [["a", "b"], ["", ""]]);
});

test("空文字列は空の表を返す", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("閉じられていない引用符は、残り全体を1セルとして扱う", () => {
  assert.deepEqual(parseCsv('a\r\n"unterminated,x'), [["a"], ["unterminated,x"]]);
});
