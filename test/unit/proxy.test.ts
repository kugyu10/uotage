// #9 レビュー[最高]-1: proxy.ts はソース文字列の正規表現一致でしか検証されておらず、
// 認可バイパス（クライアント自称ヘッダーの信頼、トークン省略、未設定時の無認証公開）を
// 埋め込んでも npm run test が無言で通っていた。ここでは実際に proxy() を呼び、
// jose の [jwksCache] シードでネットワーク無しに実物の JWT 検証を通して確認する。
import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, jwksCache, SignJWT } from "jose";
import { NextRequest } from "next/server";

import { proxy } from "../../src/proxy.ts";
import { ACCESS_EMAIL_HEADER, ACCESS_JWT_COOKIE, ACCESS_JWT_HEADER } from "../../src/lib/cloudflare-access.ts";

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key-1";
  const seededCache = { jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, uat: Date.now() };
  const jwksOptions = { [jwksCache]: seededCache };
  const sign = (payload: Record<string, unknown>, opts: { skipAud?: boolean; skipIssuer?: boolean } = {}) => {
    let builder = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid }).setIssuedAt().setExpirationTime("5m");
    if (!opts.skipIssuer) builder = builder.setIssuer(`https://${TEAM_DOMAIN}`);
    if (!opts.skipAud) builder = builder.setAudience(AUDIENCE);
    return builder.sign(privateKey);
  };
  return { jwksOptions, sign };
}

// NextResponse.next({ request: { headers } }) は実際のヘッダー書き換えを行わず、
// 下流（Next.js本体）へ「このヘッダーで request を差し替えろ」と伝える特殊ヘッダーを
// レスポンス側に積む。テストではそのヘッダーを読んで、積み直された値を検証する。
function overriddenRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

test("CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD が未設定なら 503（無認証公開しない）", async () => {
  const request = new NextRequest("https://example.com/admin");
  const response = await proxy(request, { teamDomain: undefined, audience: undefined });
  assert.equal(response.status, 503);
});

test("トークンが無ければ 403", async () => {
  const request = new NextRequest("https://example.com/admin");
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE });
  assert.equal(response.status, 403);
});

test("署名が不正なトークンは 403", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" });
  const [header, payload, signature] = token.split(".");
  assert.ok(header && payload && signature);
  const mid = Math.floor(payload.length / 2);
  const flipped = payload[mid] === "a" ? "b" : "a";
  const tampered = `${header}.${payload.slice(0, mid)}${flipped}${payload.slice(mid + 1)}.${signature}`;

  const request = new NextRequest("https://example.com/admin", {
    headers: { [ACCESS_JWT_HEADER]: tampered },
  });
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });
  assert.equal(response.status, 403);
});

test("audience が別アプリ宛のトークンは 403", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" }, { skipAud: true });
  const request = new NextRequest("https://example.com/admin", { headers: { [ACCESS_JWT_HEADER]: token } });
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });
  assert.equal(response.status, 403);
});

test("正当なトークンなら next() し、検証済みメールが内部ヘッダーへ積まれる", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" });
  const request = new NextRequest("https://example.com/admin", { headers: { [ACCESS_JWT_HEADER]: token } });
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });

  assert.equal(response.status, 200);
  assert.equal(overriddenRequestHeader(response, ACCESS_EMAIL_HEADER), "reader@example.com");
});

test("Cookie 経由のトークンも受け付ける（ブラウザ直アクセス経路）", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "cookie-reader@example.com" });
  const request = new NextRequest("https://example.com/admin", {
    headers: { cookie: `${ACCESS_JWT_COOKIE}=${token}` },
  });
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });

  assert.equal(response.status, 200);
  assert.equal(overriddenRequestHeader(response, ACCESS_EMAIL_HEADER), "cookie-reader@example.com");
});

// [最高]-1 S1 を直接殺すテスト: クライアントが自分で x-access-user-email を
// 送りつけてきても、JWT 検証済みの値で必ず上書きされ、attacker の値が
// 下流へ渡らないことを確認する。
test("クライアントが自称した x-access-user-email は、JWT 検証済みの値で上書きされる", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" });
  const request = new NextRequest("https://example.com/admin", {
    headers: {
      [ACCESS_JWT_HEADER]: token,
      [ACCESS_EMAIL_HEADER]: "attacker@example.com",
    },
  });
  const response = await proxy(request, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });

  assert.equal(response.status, 200);
  const overridden = overriddenRequestHeader(response, ACCESS_EMAIL_HEADER);
  assert.equal(overridden, "reader@example.com");
  assert.notEqual(overridden, "attacker@example.com");
});
