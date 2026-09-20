import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { ACCESS_EMAIL_HEADER } from "@/lib/cloudflare-access";
import { resolveOperator } from "@/lib/operator-session";

/**
 * 認証済みユーザーが所属するテナントを、DBを正として検証する。
 *
 * 認証そのもの（誰が来たか）は Cloudflare Access が担い、Access を通過した
 * リクエストにだけ `src/proxy.ts` が検証済みメールアドレスをヘッダーへ積む。
 * ここでは「その人が operators に登録済みか」だけを DB で確認する
 * （実体は `src/lib/operator-session.ts` の resolveOperator。ここは
 * "server-only" / next/headers 依存の薄いラッパ）。
 *
 * Supabase Auth のセッションはもう存在しないため、RLS（auth.uid() 前提）は
 * 機能しない。そのため service role クライアントで RLS を迂回し、テナント境界は
 * 呼び出し側の `.eq("tenant_id", operator.tenant_id)` で保証する。
 * RLS ポリシー自体の整理は #9 の対象外（移行アセスメント P5 で撤去予定）。
 */
export async function requireOperator() {
  const headerList = await headers();
  const email = headerList.get(ACCESS_EMAIL_HEADER);
  const supabase = createAdminClient();

  const result = await resolveOperator(email, async (normalizedEmail) => {
    const { data } = await supabase
      .from("operators")
      .select("tenant_id, user_id")
      .eq("user_id", normalizedEmail)
      .limit(1)
      .maybeSingle();
    return data ?? null;
  });

  if (result.status !== "found") {
    // ヘッダー欠落（missing-email）・未登録メール（not-found）のどちらも、
    // 存在有無を出さず 404 として扱う。/admin へ redirect() すると layout.tsx が
    // 再びここを呼んで無限リダイレクトになるため、自分自身へは戻さない。
    notFound();
  }

  return { supabase, operator: result.operator };
}
