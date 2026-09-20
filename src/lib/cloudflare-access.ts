/**
 * Cloudflare Access 連携で使う定数と JWT 検証ロジック。
 *
 * `src/proxy.ts`（Edge Middleware）と `src/lib/supabase/server.ts`
 * （Server Components / Actions）の両方から参照するため、
 * "server-only" に依存しないプレーンなモジュールにしてある。
 * JWT 検証本体をここへ切り出しているのは、Next.js の Request/Response を
 * 経由せずユニットテストできるようにするため（jose の `[jwksCache]` で
 * ネットワークフェッチ無しに検証できる）。
 */
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSetOptions } from "jose";

/** Cloudflare Access が付与する、検証済みJWTのヘッダー名。 */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Cloudflare Access が付与する、検証済みJWTのCookie名（ブラウザ経由アクセス時）。 */
export const ACCESS_JWT_COOKIE = "CF_Authorization";

/**
 * proxy.ts が JWT 検証後に積み直す、検証済みメールアドレスの内部ヘッダー名。
 * クライアントから直接送られてきた同名ヘッダーは proxy.ts が必ず上書きするため、
 * このヘッダーを信頼してよいのは `/admin/:path*` の matcher を通った場合のみ。
 */
export const ACCESS_EMAIL_HEADER = "x-access-user-email";

const jwksCacheByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string, jwksOptions?: RemoteJWKSetOptions) {
  // jwksOptions（テスト用の [jwksCache] シード等）が渡された呼び出しはキャッシュを共有しない。
  if (jwksOptions) return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), jwksOptions);
  let jwks = jwksCacheByDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCacheByDomain.set(teamDomain, jwks);
  }
  return jwks;
}

export interface VerifyAccessJwtResult {
  email: string;
}

/**
 * Cloudflare Access の JWT を検証し、`email` クレームを取り出す。
 * 失敗（署名不正・issuer/audience不一致・email欠落）した場合は throw する。
 */
export async function verifyAccessJwt(
  token: string,
  params: { teamDomain: string; audience: string; jwksOptions?: RemoteJWKSetOptions },
): Promise<VerifyAccessJwtResult> {
  const { teamDomain, audience, jwksOptions } = params;
  const { payload } = await jwtVerify(token, getJwks(teamDomain, jwksOptions), {
    issuer: `https://${teamDomain}`,
    audience,
  });
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) throw new Error("Access JWT にメールアドレスが含まれていません。");
  return { email };
}
