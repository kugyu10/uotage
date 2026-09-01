// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
// 実際の PostgREST は起動できないため、`.range(from, to)` と同じ意味（両端を含む）の
// 偽のページ取得関数を用意して、ページング側の境界処理だけを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchAllPages,
  fetchInChunks,
  SUPABASE_IN_CHUNK_SIZE,
  TOO_MANY_ROWS,
} from "../../src/lib/supabase/paginate.ts";

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

test("maxRows 判定は最終ページが部分ページでも効く", async () => {
  // 判定を break の後ろに置くと、満杯ページ2回(20行) + 部分ページ(5行) = 25行が
  // maxRows=20 を超えていても throw されずに返ってしまう。
  const rows = Array.from({ length: 25 }, (_unused, index) => index);
  const { fetchPage } = fakeTable(rows);
  await assert.rejects(() => fetchAllPages(fetchPage, 10, 20), new RegExp(TOO_MANY_ROWS));
});

test("maxRows 判定は1ページで返り切る場合にも効く", async () => {
  const rows = Array.from({ length: 5 }, (_unused, index) => index);
  const { fetchPage } = fakeTable(rows);
  await assert.rejects(() => fetchAllPages(fetchPage, 10, 4), new RegExp(TOO_MANY_ROWS));
  // ちょうど上限なら通す（> 判定であることの確認）。
  assert.deepEqual(await fetchAllPages(fakeTable(rows).fetchPage, 10, 5), rows);
});

// ============================== fetchInChunks ==============================

/** `.in(column, chunk)` を模した偽のテーブル。チャンクに含まれるキーの行だけを返す。 */
function fakeKeyedTable(rowsByKey: Record<string, number[]>) {
  const chunks: string[][] = [];
  const fetchChunkPage = (chunk: string[], from: number, to: number) => {
    chunks.push(chunk);
    const matched = chunk.flatMap((key) => (rowsByKey[key] ?? []).map((value) => ({ key, value })));
    return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
  };
  return { fetchChunkPage, chunks };
}

test("fetchInChunks は keys を chunkSize 件ずつに割って .in() に渡す", async () => {
  const rowsByKey = { a: [1], b: [2], c: [3], d: [4], e: [5] };
  const { fetchChunkPage, chunks } = fakeKeyedTable(rowsByKey);

  const rows = await fetchInChunks(["a", "b", "c", "d", "e"], fetchChunkPage, 2);

  assert.deepEqual(chunks, [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(
    rows.map((row) => row.value),
    [1, 2, 3, 4, 5],
  );
});

test("fetchInChunks は空の keys でクエリを1回も投げない", async () => {
  const { fetchChunkPage, chunks } = fakeKeyedTable({});
  assert.deepEqual(await fetchInChunks([], fetchChunkPage, 2), []);
  assert.deepEqual(chunks, []);
});

test("fetchInChunks は1件でも動く", async () => {
  const { fetchChunkPage, chunks } = fakeKeyedTable({ a: [1] });
  const rows = await fetchInChunks(["a"], fetchChunkPage, 500);
  assert.deepEqual(chunks, [["a"]]);
  assert.deepEqual(rows.map((row) => row.value), [1]);
});

test("fetchInChunks は chunkSize の境界でチャンク数が変わる", async () => {
  const keys = Array.from({ length: 10 }, (_unused, index) => `k${index}`);
  const rowsByKey = Object.fromEntries(keys.map((key, index) => [key, [index]]));

  // ちょうど割り切れる: 余分なチャンクを作らない。
  const exact = fakeKeyedTable(rowsByKey);
  await fetchInChunks(keys, exact.fetchChunkPage, 5);
  assert.equal(exact.chunks.length, 2);

  // 1件超える: 最後に1件だけのチャンクができる。
  const overflow = fakeKeyedTable(rowsByKey);
  await fetchInChunks(keys, overflow.fetchChunkPage, 9);
  assert.deepEqual(overflow.chunks.map((chunk) => chunk.length), [9, 1]);

  // keys がちょうど1チャンクに収まる。
  const single = fakeKeyedTable(rowsByKey);
  await fetchInChunks(keys, single.fetchChunkPage, 10);
  assert.equal(single.chunks.length, 1);
});

test("fetchInChunks は keys を重複除去してから割る", async () => {
  const { fetchChunkPage, chunks } = fakeKeyedTable({ a: [1], b: [2] });
  const rows = await fetchInChunks(["a", "b", "a", "b", "a"], fetchChunkPage, 10);
  assert.deepEqual(chunks, [["a", "b"]]);
  // 同じ行が2回積まれない。
  assert.deepEqual(rows.map((row) => row.value), [1, 2]);
});

test("fetchInChunks はチャンク内がページサイズを超えてもページングして取り切る", async () => {
  // 1キーが複数行を持つ場合（reader_labels のような 1:N）。
  const rowsByKey = { a: [1, 2, 3], b: [4, 5, 6] };
  const { fetchChunkPage } = fakeKeyedTable(rowsByKey);
  const rows = await fetchInChunks(["a", "b"], fetchChunkPage, 10, 2);
  assert.deepEqual(rows.map((row) => row.value), [1, 2, 3, 4, 5, 6]);
});

test("fetchInChunks はチャンクのエラーを部分結果に化けさせず throw する", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fetchInChunks<string, number>(["a", "b", "c", "d"], (chunk) => {
        calls += 1;
        if (chunk.includes("a")) return Promise.resolve({ data: [1, 2], error: null });
        return Promise.resolve({ data: null, error: { message: "414 too long" } });
      }, 2, 10),
    /414 too long/,
  );
  assert.equal(calls, 2);
});

test("fetchInChunks は maxRows を超えたら TOO_MANY_ROWS を throw する", async () => {
  const keys = Array.from({ length: 10 }, (_unused, index) => `k${index}`);
  const rowsByKey = Object.fromEntries(keys.map((key, index) => [key, [index]]));
  const { fetchChunkPage } = fakeKeyedTable(rowsByKey);
  await assert.rejects(() => fetchInChunks(keys, fetchChunkPage, 2, 10, 5), new RegExp(TOO_MANY_ROWS));
});

test("fetchInChunks は不正な chunkSize でも無限ループせず既定値で割る", async () => {
  const { fetchChunkPage, chunks } = fakeKeyedTable({ a: [1], b: [2] });
  await fetchInChunks(["a", "b"], fetchChunkPage, 0);
  assert.deepEqual(chunks, [["a", "b"]]);
  assert.ok(SUPABASE_IN_CHUNK_SIZE >= 2);
});

test("SUPABASE_IN_CHUNK_SIZE はURI長が破綻しない件数に収まっている", () => {
  // UUIDはURLエンコード後で1件あたり約39文字。上限を緩めたら気付けるようにする。
  const estimatedUriBytes = SUPABASE_IN_CHUNK_SIZE * 39;
  assert.ok(estimatedUriBytes < 64 * 1024, `.in() のクエリ文字列が約${estimatedUriBytes}バイトになる`);
});
