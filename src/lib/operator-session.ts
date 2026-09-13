/**
 * requireOperator() の中核ロジックを、"server-only" / "next/headers" に依存しない
 * 純粋な関数として切り出したもの。
 *
 * `src/lib/supabase/server.ts` は "server-only" を import するため、Next.js の
 * React Server Component 実行環境の外（素の Node / `node --test`）では
 * import した時点で失敗する。ここを薄いラッパにして本体をこちらへ出すことで、
 * requireOperator() の振る舞い（ヘッダー欠落・メール未登録・大文字小文字ゆらぎの
 * 正規化）をユニットテスト（test/unit/operator-session.test.ts）で実行して確認できる。
 */

export interface Operator {
  tenant_id: string;
  user_id: string;
}

export type OperatorLookupResult =
  | { status: "missing-email" }
  | { status: "not-found" }
  | { status: "found"; operator: Operator };

/**
 * operators.user_id は運用者が手入力するため、大文字小文字のゆらぎで
 * Access は通るのに 404 になる事故を避ける。比較は小文字化して行う
 * （DB 側も小文字で登録する運用。supabase/migrations の該当ファイル参照）。
 */
export function normalizeAccessEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Cloudflare Access が検証したメールアドレス（`x-access-user-email` から取得済みの値）
 * を元に、operators テーブルでの所属確認を行う。
 *
 * @param email  proxy.ts が積んだ検証済みメールアドレス。ヘッダー自体が無ければ null。
 * @param findOperator  正規化済みメールアドレスで operators を検索する関数。
 *   DB アクセスをここへ注入することで、この関数自体はテスト時にネットワーク／
 *   Supabase クライアントを必要としない。
 */
export async function resolveOperator(
  email: string | null,
  findOperator: (normalizedEmail: string) => Promise<Operator | null>,
): Promise<OperatorLookupResult> {
  if (!email) {
    // proxy.ts の matcher（/admin/:path*）を通っていれば必ず付くヘッダー。
    // 無い場合は設定不備や直接呼び出しなので、情報を出さずに拒否する。
    return { status: "missing-email" };
  }

  const normalizedEmail = normalizeAccessEmail(email);
  const operator = await findOperator(normalizedEmail);
  if (!operator) {
    // ログイン画面は撤去済み。Access 認証済みだが operators 未登録のユーザーには
    // 存在有無を出さず 404 として扱う。
    return { status: "not-found" };
  }

  return { status: "found", operator };
}
