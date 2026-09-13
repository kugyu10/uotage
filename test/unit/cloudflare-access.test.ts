// #9: proxy.ts の文字列検査だけでなく、実際に JWT を署名・検証して
// verifyAccessJwt() の振る舞いを確認する。
// ネットワークの JWKS フェッチを避けるため、jose の [jwksCache] シンボルへ
// 自前で生成した鍵を事前投入する（createRemoteJWKSet はこのシードがあれば
// フェッチしない）。
import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, jwksCache, SignJWT } from "jose";

import { verifyAccessJwt } from "../../src/lib/cloudflare-access.ts";

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const AUDIENCE = "test-aud-tag";

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "test-key-1";
  const seededCache = {
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
    uat: Date.now(),
  };
  const jwksOptions = { [jwksCache]: seededCache };
  const sign = (payload: Record<string, unknown>, opts: { skipAud?: boolean; skipIssuer?: boolean } = {}) => {
    let builder = new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setExpirationTime("5m");
    if (!opts.skipIssuer) builder = builder.setIssuer(`https://${TEAM_DOMAIN}`);
    if (!opts.skipAud) builder = builder.setAudience(AUDIENCE);
    return builder.sign(privateKey);
  };
  return { jwksOptions, sign };
}

test("正しい issuer/audience/署名かつ email クレームありなら通す", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" });
  const result = await verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions });
  assert.equal(result.email, "reader@example.com");
});

test("email クレームが無ければ throw する", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ sub: "no-email-user" });
  await assert.rejects(() => verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions }));
});

test("audience が一致しなければ throw する（別アプリ宛のトークンを拒否）", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" }, { skipAud: true });
  await assert.rejects(() => verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions }));
});

test("issuer が一致しなければ throw する（別チーム宛のトークンを拒否）", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" }, { skipIssuer: true });
  await assert.rejects(() => verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions }));
});

test("改ざんされた署名は throw する", async () => {
  const { jwksOptions, sign } = await setup();
  const token = await sign({ email: "reader@example.com" });
  // payload セグメントの中央付近を1文字だけ変える。base64url の末尾数ビットは
  // デコーダによって無視されうる（末尾の1文字を弄っても偶然バイト値が変わらない
  // ケースがある）ため、境界を避けて中央を弄って署名不一致を確実に起こす。
  const [header, payload, signature] = token.split(".");
  assert.ok(header && payload && signature);
  const mid = Math.floor(payload.length / 2);
  const flipped = payload[mid] === "a" ? "b" : "a";
  const tamperedPayload = `${payload.slice(0, mid)}${flipped}${payload.slice(mid + 1)}`;
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  await assert.rejects(() => verifyAccessJwt(tampered, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, jwksOptions }));
});
