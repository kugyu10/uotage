import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.redirect(new URL("/login?setup=required", request.url));
  const supabase = createServerClient(url, key, { cookies: {
    getAll: () => request.cookies.getAll(),
    setAll: (values) => {
      values.forEach(({ name, value }) => request.cookies.set(name, value));
      response = NextResponse.next({ request });
      values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
    },
  } });
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    // 認証後の遷移先は /auth/callback が常に /admin へ固定する。
    // 元のパスへ戻す機能は、オープンリダイレクトを避けるため
    // 許可リスト方式で実装するまで持たない。
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return response;
}

export const config = { matcher: ["/admin/:path*"] };
