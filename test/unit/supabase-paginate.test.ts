// ソース文字列への正規表現マッチではなく、実装を import して振る舞いを検証する。
// 実際の PostgREST は起動できないため、`.range(from, to)` と同じ意味（両端を含む）の
// 偽のページ取得関数を用意して、ページング側の境界処理だけを検証する。
import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchAllPages,
  fetchInChunks,
  SUPABASE_CHUNK_CONCURRENCY,
  SUPABASE_IN_CHUNK_SIZE,
  TOO_MANY_ROWS,
} from "../../src/lib/supabase/paginate.ts";

/** マイクロタスクを1回挟むだけの遅延。setTimeout より速く、実行順序の検証に十分。 */
function microtaskDelay(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

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

// ======================= fetchInChunks の並列実行 (issue #6) =======================

test("SUPABASE_CHUNK_CONCURRENCY はコネクションを食い潰さない範囲（2〜4）に収まっている", () => {
  assert.ok(
    SUPABASE_CHUNK_CONCURRENCY >= 2 && SUPABASE_CHUNK_CONCURRENCY <= 4,
    `SUPABASE_CHUNK_CONCURRENCY=${SUPABASE_CHUNK_CONCURRENCY} は issue #6 で検討された範囲外`,
  );
});

test("fetchInChunks はチャンクを concurrency 件までしか同時に実行しない", async () => {
  const keys = Array.from({ length: 9 }, (_unused, index) => `k${index}`);
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchChunkPage = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // マイクロタスクを何度か挟んで、他のワーカーが追いつく猶予を作る。
    await microtaskDelay();
    await microtaskDelay();
    inFlight -= 1;
    return { data: [1], error: null };
  };

  await fetchInChunks<string, number>(keys, fetchChunkPage, 1, 10, 1000, 3);

  assert.equal(maxInFlight, 3, "concurrency=3 を指定したのに同時実行数が異なる");
});

test("fetchInChunks は concurrency=1 なら従来どおり直列実行になる（後方互換）", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchChunkPage = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await microtaskDelay();
    inFlight -= 1;
    return { data: [1], error: null };
  };

  await fetchInChunks<string, number>(["a", "b", "c", "d"], fetchChunkPage, 1, 10, 1000, 1);

  assert.equal(maxInFlight, 1);
});

test("fetchInChunks は同時実行でも結果をチャンクの元の並び順で連結する（解決順ではない）", async () => {
  // 先頭のチャンクほど遅く解決するようにして、完了順と元の並び順をわざとずらす。
  const rowsByChunk: Record<string, number> = { a: 1, b: 2, c: 3 };
  const fetchChunkPage = async (chunk: string[]) => {
    const key = chunk[0];
    const delays: Record<string, number> = { a: 2, b: 1, c: 0 };
    for (let i = 0; i < delays[key]; i += 1) {
      await microtaskDelay();
    }
    return { data: [rowsByChunk[key]], error: null };
  };

  const rows = await fetchInChunks<string, number>(["a", "b", "c"], fetchChunkPage, 1, 10, 1000, 3);

  // "c" が先に解決しても、結果は a, b, c の元の順序で並ぶ。
  assert.deepEqual(rows, [1, 2, 3]);
});

test("fetchInChunks はチャンクが失敗したら以降のチャンクに新規着手しない", async () => {
  const started: string[] = [];
  let releaseA: (() => void) | undefined;

  const fetchChunkPage = (chunk: string[]) => {
    const key = chunk[0];
    started.push(key);
    if (key === "a") {
      // "a" は手動で解決させるまで pending のままにし、"b" の失敗を先に確定させる。
      return new Promise<{ data: number[] | null; error: unknown }>((resolve) => {
        releaseA = () => resolve({ data: [1], error: null });
      });
    }
    if (key === "b") {
      return Promise.resolve({ data: null, error: { message: "boom" } });
    }
    // "c" "d" に着手してしまったら失敗させて検出する（本来ここには来ないはず）。
    return Promise.resolve({ data: null, error: { message: `想定外に ${key} へ着手した` } });
  };

  const promise = fetchInChunks<string, number>(["a", "b", "c", "d"], fetchChunkPage, 1, 10, 1000, 2);
  // 失敗を先送りできるよう、rejection を早期に観測しても未処理拒否にならないようにしておく。
  promise.catch(() => {});

  // "b" の失敗が worker 内で catch → hasError=true まで処理し終わるのを待つ。
  // この時点でまだ "a" は pending なので、Promise.all 自体はまだ解決していない。
  for (let i = 0; i < 10; i += 1) {
    await microtaskDelay();
  }
  assert.deepEqual(started, ["a", "b"], "b の失敗より前に想定外のチャンクへ着手している");

  // ここで初めて "a" を解決させる。"b" が既に失敗している(hasError=true)ので、
  // "a" を終えたワーカーは次のチャンク("c")には着手せず抜けるはず。
  releaseA?.();

  await assert.rejects(promise, /boom/);
  assert.deepEqual(started, ["a", "b"], "b の失敗後に c/d へ着手してしまっている");
});
