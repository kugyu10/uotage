import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { publicEnv } from "@/lib/env";

export async function createUserClient() {
  const cookieStore = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server ComponentではProxyがCookie更新を担当する。 */ }
      },
    },
  });
}

/** 認証済みユーザーが所属するテナントを、DBを正として検証する。 */
export async function requireOperator() {
  const supabase = await createUserClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const { data: operator } = await supabase.from("operators")
    .select("tenant_id")
    .eq("user_id", auth.user.id)
    .limit(1)
    .maybeSingle();
  if (!operator) redirect("/login?error=operator");

  return { supabase, operator };
}
