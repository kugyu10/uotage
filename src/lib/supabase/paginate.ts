/**
 * 大きな結果セットを `.range()` で1ページずつ積み上げて取得する。
 *
 * 既存のエクスポートは `.in("id", readerIds)` に読者IDを全件渡していた。UUIDは1件あたり
 * 約37文字なので読者2,000人でクエリ文字列が約74KBになり、PostgREST/プロキシのURI長制限に
 * 当たる。ページングして `.in()` に渡すIDを1ページ分に絞ればURI長が有界になる。
 *
 * PostgREST 側に `db-max-rows` が設定されている環境では、`.range()` を付けない取得が
 * 黙って打ち切られる。ページングはその取りこぼしも同時に防ぐ。
 * ここではページングを一箇所に閉じ込め、呼び出し側は1ページ分のクエリだけを組む。
 */

/** 1ページあたりの取得件数。`.in()` に渡すID数の上限も兼ねる（URI長を有界にするため）。 */
export const SUPABASE_PAGE_SIZE = 1000;

/**
 * 1回の取得で扱う行数の絶対上限。
 * これを超える場合は黙って打ち切らず例外にする（不完全なCSVを渡すほうが危険なため）。
 * 値はメモリ実測に基づくものではなく、安全側に置いた暫定値。
 * 実運用でこの上限に当たるテナントが出たら、ストリーミング化を含めて再検討する。
 */
export const MAX_PAGINATED_ROWS = 50_000;

/** MAX_PAGINATED_ROWS を超えたときに投げるエラーの message。呼び出し側で文言に変換する。 */
export const TOO_MANY_ROWS = "TOO_MANY_ROWS";

/** PostgREST のエラーは `{ message, code, ... }` 形なので、message を拾って Error に包む。 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return new Error((error as { message: string }).message);
  }
  return new Error(String(error));
}

interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * `fetchPage(from, to)` を最後のページまで呼び出し、全行を連結して返す。
 *
 * 呼び出し側の責務:
 *   - `fetchPage` は必ず一意なキーで `.order()` すること。順序が安定しないページングは
 *     行の重複・欠落を生む。
 *   - `from` / `to` は `.range(from, to)` にそのまま渡す（両端を含む）。
 *
 * `error` が返ったら即座に throw する（部分的な結果でCSVを作らない）。
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = SUPABASE_PAGE_SIZE,
  maxRows: number = MAX_PAGINATED_ROWS,
): Promise<T[]> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : SUPABASE_PAGE_SIZE;
  const rows: T[] = [];

  for (let from = 0; ; from += size) {
    const { data, error } = await fetchPage(from, from + size - 1);
    if (error) throw toError(error);

    const page = data ?? [];
    rows.push(...page);

    // 上限判定は break より前に置く。後ろに置くと、最終ページが部分ページのときに
    // 上限を超えていても throw せず返してしまう（満杯ページ50回 + 500行 = 50,500行）。
    if (rows.length > maxRows) throw new Error(TOO_MANY_ROWS);

    // 返ってきた件数がページサイズ未満なら最終ページ。
    // ちょうど割り切れる場合だけ空ページを1回余分に引く。
    if (page.length < size) break;
  }

  return rows;
}

/**
 * `.in(column, keys)` に渡すIDの上限件数。
 *
 * UUIDは1件あたりURLエンコード後で約39文字（`%22`付きの引用符とカンマを含む）、
 * メールアドレスは約30〜40文字。500件なら約20KBで、PostgREST の手前にいる
 * Kong/nginx のリクエストライン上限に対して十分な余裕がある。
 * 1000件（約39KB）でも通る環境が多いが、経路にプロキシが増えたときに
 * 最初に壊れる場所なので保守的な値にしておく。
 */
export const SUPABASE_IN_CHUNK_SIZE = 500;

/**
 * `.in(column, keys)` の keys を SUPABASE_IN_CHUNK_SIZE 件ずつに分けて引き、全結果を連結する。
 *
 * IDを全件 `.in()` に渡すとクエリ文字列が数百KBになり URI長制限（414）に当たる。
 * さらに 414 を無視して `data ?? []` で受けると「該当0件」と区別できず、
 * 「既存読者が全員新規に見える」ような静かな嘘になる。ここでは error を必ず throw する。
 *
 * 1チャンク分の結果自体がページサイズを超えることもある（例: reader_labels は
 * 1読者が複数行）ため、チャンク内はさらに fetchAllPages でページングする。
 *
 * チャンクは直列に処理する。並列化すると往復回数ぶんレイテンシが縮むが、
 * 無制限に並列化すると Supabase のコネクションを食い潰すため、並列度は実測してから
 * 決める（issue #6）。調整用の引数がすべて数値の位置引数である点も既知（issue #5）。
 * `fetchChunkPage` は `(chunk, from, to)` を受け、`.in(column, chunk).order(...).range(from, to)`
 * を組むこと。keys は重複除去してから使うので、呼び出し側で dedupe しなくてよい。
 */
export async function fetchInChunks<K, T>(
  keys: readonly K[],
  fetchChunkPage: (chunk: K[], from: number, to: number) => PromiseLike<PageResult<T>>,
  chunkSize: number = SUPABASE_IN_CHUNK_SIZE,
  pageSize: number = SUPABASE_PAGE_SIZE,
  maxRows: number = MAX_PAGINATED_ROWS,
): Promise<T[]> {
  const uniqueKeys = Array.from(new Set(keys));
  if (uniqueKeys.length === 0) return [];

  const size = Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : SUPABASE_IN_CHUNK_SIZE;
  const rows: T[] = [];

  for (let start = 0; start < uniqueKeys.length; start += size) {
    const chunk = uniqueKeys.slice(start, start + size);
    const chunkRows = await fetchAllPages<T>(
      (from, to) => fetchChunkPage(chunk, from, to),
      pageSize,
      maxRows,
    );
    rows.push(...chunkRows);
    if (rows.length > maxRows) throw new Error(TOO_MANY_ROWS);
  }

  return rows;
}
