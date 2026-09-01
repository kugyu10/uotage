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
 * 1回のエクスポートで扱う行数の絶対上限。
 * これを超える場合は黙って打ち切らず例外にする（不完全なCSVを渡すほうが危険なため）。
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

    // 返ってきた件数がページサイズ未満なら最終ページ。
    // ちょうど割り切れる場合だけ空ページを1回余分に引く。
    if (page.length < size) break;
    if (rows.length > maxRows) throw new Error(TOO_MANY_ROWS);
  }

  return rows;
}
