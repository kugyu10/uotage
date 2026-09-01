import "server-only";

import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * RFC 8058 のワンクリック解除。`List-Unsubscribe-Post` に対応した
 * メールクライアントはこのURIへ POST する。
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("u") ?? "";
  if (TOKEN_PATTERN.test(token)) {
    const { error } = await createAdminClient().from("readers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("tenant_id", defaultTenantId()).eq("unsubscribe_token", token)
      .is("unsubscribed_at", null);
    if (error) return Response.json({ ok: false }, { status: 500 });
  }
  // トークンが不正でも ok を返す。存在するトークンかどうかを外部に漏らさない。
  return Response.json({ ok: true });
}

/**
 * RFC 8058 に対応していないメールクライアントは、同じ `List-Unsubscribe` の
 * URIを GET で開く。405 を返すと解除できないため、確認ページへ逃がす。
 *
 * GET では解除を実行しない。メールのリンクスキャナやプリフェッチが
 * GET を投げるため、意図しない解除が起きる。
 */
export function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("u") ?? "";
  // Location は相対で返す。プロキシ配下では request.url のホストが
  // 公開ドメインと一致しないことがあり、絶対URLだと内部ホストへ飛ばしうる。
  const location = TOKEN_PATTERN.test(token)
    ? `/unsubscribe?u=${encodeURIComponent(token)}`
    : "/unsubscribe";
  return new Response(null, { status: 303, headers: { Location: location } });
}
