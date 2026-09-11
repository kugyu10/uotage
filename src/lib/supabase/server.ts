import "server-only";

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { ACCESS_EMAIL_HEADER } from "@/lib/cloudflare-access";

/**
 * 認証済みユーザーが所属するテナントを、DBを正として検証する。
 *
 * 認証そのもの（誰が来たか）は Cloudflare Access が担い、Access を通過した
 * リクエストにだけ `src/proxy.ts` が検証済みメールアドレスをヘッダーへ積む。
 * ここでは「その人が operators に登録済みか」だけを DB で確認する。
 *
 * Supabase Auth のセッションはもう存在しないため、RLS（auth.uid() 前提）は
 * 機能しない。そのため service role クライアントで RLS を迂回し、テナント境界は
 * 呼び出し側の `.eq("tenant_id", operator.tenant_id)` で保証する。
 * RLS ポリシー自体の整理は #9 の対象外（移行アセスメント P5 で撤去予定）。
 */
export async function requireOperator() {
  const headerList = await headers();
  const email = headerList.get(ACCESS_EMAIL_HEADER);
  if (!email) {
    // proxy.ts の matcher（/admin/:path*）を通っていれば必ず付くヘッダー。
    // 無い場合は設定不備や直接呼び出しなので、情報を出さずに拒否する。
    redirect("/admin");
  }

  const supabase = createAdminClient();
  const { data: operator } = await supabase
    .from("operators")
    .select("tenant_id, user_id")
    .eq("user_id", email)
    .limit(1)
    .maybeSingle();
  if (!operator) {
    // ログイン画面は撤去済み。Access 認証済みだが operators 未登録のユーザーには
    // 存在有無を出さず 404 として扱う。
    notFound();
  }

  return { supabase, operator };
}
