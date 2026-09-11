import { NextResponse, type NextRequest } from "next/server";

import {
  ACCESS_EMAIL_HEADER,
  ACCESS_JWT_COOKIE,
  ACCESS_JWT_HEADER,
  verifyAccessJwt,
} from "@/lib/cloudflare-access";

// Cloudflare Access（Zero Trust）が /admin/* の手前で認証を行う。
// ここでは Access が付けた JWT を検証し、含まれるメールアドレスを
// 下流（requireOperator）が信頼できる内部ヘッダーへ積み直すだけを行う。
export async function proxy(request: NextRequest) {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "");
  const audience = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !audience) {
    // Cloudflare Access が未設定。ログイン画面は撤去済みで代替経路が無いため、
    // 誤って管理画面を無認証公開しないよう一律で拒否する。
    return new NextResponse("Cloudflare Access が未設定です。管理者に連絡してください。", { status: 503 });
  }

  const token = request.headers.get(ACCESS_JWT_HEADER) ?? request.cookies.get(ACCESS_JWT_COOKIE)?.value;
  if (!token) {
    return new NextResponse("認証が必要です。", { status: 403 });
  }

  try {
    const { email } = await verifyAccessJwt(token, { teamDomain, audience });
    // クライアントが同名ヘッダーを送っていても、検証済みの値で必ず上書きする。
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(ACCESS_EMAIL_HEADER, email);
    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch {
    return new NextResponse("認証に失敗しました。", { status: 403 });
  }
}

export const config = { matcher: ["/admin/:path*"] };
