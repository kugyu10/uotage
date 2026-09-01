// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
// 実際の PostgREST は起動できないため、`.range(from, to)` と同じ意味（両端を含む）の
// 偽のページ取得関数を用意して、ページング側の境界処理だけを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import { fetchAllPages, TOO_MANY_ROWS } from "../../src/lib/supabase/paginate.ts";

/** rows を `.range(from, to)` と同じ意味で切り出す偽のページ取得関数。呼び出し範囲も記録する。 */
function fakeTable<T>(rows: T[]) {
  const calls: Array<[number, number]> = [];
  const fetchPage = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };
  return { fetchPage, calls };
}

test("1ページに収まる件数なら1回で取り切る", async () => {
  const { fetchPage, calls } = fakeTable([1, 2, 3]);
  assert.deepEqual(await fetchAllPages(fetchPage, 10), [1, 2, 3]);
  assert.deepEqual(calls, [[0, 9]]);
});

test("ページサイズを超える件数を順序どおり連結する", async () => {
  const rows = Array.from({ length: 25 }, (_unused, index) => index);
  const { fetchPage, calls } = fakeTable(rows);
  assert.deepEqual(await fetchAllPages(fetchPage, 10), rows);
  // range は両端を含むので 0-9 / 10-19 / 20-29 の3回。
  assert.deepEqual(calls, [
    [0, 9],
    [10, 19],
    [20, 29],
  ]);
});

test("件数がページサイズで割り切れるときは空ページを1回だけ余分に引いて終わる", async () => {
  const rows = Array.from({ length: 20 }, (_unused, index) => index);
  const { fetchPage, calls } = fakeTable(rows);
  assert.deepEqual(await fetchAllPages(fetchPage, 10), rows);
  assert.deepEqual(calls, [
    [0, 9],
    [10, 19],
    [20, 29],
  ]);
});

test("0件でも空配列を返し、2回目を引かない", async () => {
  const { fetchPage, calls } = fakeTable<number>([]);
  assert.deepEqual(await fetchAllPages(fetchPage, 10), []);
  assert.deepEqual(calls, [[0, 9]]);
});

test("data が null のページは空ページとして扱い、そこで打ち切る", async () => {
  let called = 0;
  const rows = await fetchAllPages<number>(() => {
    called += 1;
    return Promise.resolve({ data: null, error: null });
  }, 10);
  assert.deepEqual(rows, []);
  assert.equal(called, 1);
});

test("error が返ったら部分的な結果を返さず throw する", async () => {
  let called = 0;
  await assert.rejects(
    () =>
      fetchAllPages<number>((from) => {
        called += 1;
        if (from === 0) return Promise.resolve({ data: [1, 2], error: null });
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }, 2),
    /boom/,
  );
  // 2ページ目で失敗したら3ページ目は引かない。
  assert.equal(called, 2);
});

test("Error 以外の error でも Error に包んで throw する", async () => {
  await assert.rejects(
    () => fetchAllPages<number>(() => Promise.resolve({ data: null, error: "文字列エラー" }), 10),
    /文字列エラー/,
  );
});

test("maxRows を超えたら不完全な結果を返さず TOO_MANY_ROWS を throw する", async () => {
  const rows = Array.from({ length: 100 }, (_unused, index) => index);
  const { fetchPage } = fakeTable(rows);
  await assert.rejects(() => fetchAllPages(fetchPage, 10, 25), new RegExp(TOO_MANY_ROWS));
});

test("maxRows と同数で収まる場合は throw しない", async () => {
  const rows = Array.from({ length: 25 }, (_unused, index) => index);
  const { fetchPage } = fakeTable(rows);
  assert.deepEqual(await fetchAllPages(fetchPage, 10, 25), rows);
});

test("不正なページサイズでも無限ループせず既定サイズで取り切る", async () => {
  const rows = Array.from({ length: 3 }, (_unused, index) => index);
  const { fetchPage, calls } = fakeTable(rows);
  assert.deepEqual(await fetchAllPages(fetchPage, 0), rows);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [0, 999]);
});
