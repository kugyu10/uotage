import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const proxy = await readFile(new URL('../src/proxy.ts', import.meta.url), 'utf8');
const cloudflareAccess = await readFile(new URL('../src/lib/cloudflare-access.ts', import.meta.url), 'utf8');
const admin = await readFile(new URL('../src/app/admin/page.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../src/app/admin/layout.tsx', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/lib/supabase/server.ts', import.meta.url), 'utf8');
const operatorSession = await readFile(new URL('../src/lib/operator-session.ts', import.meta.url), 'utf8');

const sectionPages = [
  'mail/page.tsx',
  'courses/page.tsx',
  'labels/page.tsx',
  'settings/page.tsx',
  'funnels/page.tsx',
  'products/page.tsx',
  'registration-paths/page.tsx',
];
const sections = await Promise.all(
  sectionPages.map((path) => readFile(new URL(`../src/app/admin/${path}`, import.meta.url), 'utf8')),
);

test('admin routes require a verified Cloudflare Access JWT and operator membership', () => {
  // #9: Supabase Auth（getClaims）から Cloudflare Access の JWT 検証へ移行。
  // 実際の署名検証・issuer/audience チェックおよび認可バイパスが無いことは
  // test/unit/cloudflare-access.test.ts と test/unit/proxy.test.ts で
  // 実際に proxy() / verifyAccessJwt() を実行して確認している。
  // requireOperator() の振る舞い（ヘッダー欠落・未登録・大文字小文字正規化）は
  // test/unit/operator-session.test.ts が resolveOperator() を実行して確認している。
  // このテストはソース文字列の一致だけを見るため、それらの実行系テストの補助
  // （リファクタで壊れていないかの目視用）に留める。
  assert.match(proxy, /verifyAccessJwt\(/);
  assert.doesNotMatch(proxy, /getClaims\(\)/);
  assert.match(proxy, /matcher: \["\/admin\/:path\*"\]/);
  // クライアントが送ってきた x-access-user-email を優先させる壊し方（S1）を
  // 目視でも検知できるよう、必ず検証済みの値で上書きしている行を固定する。
  assert.match(proxy, /requestHeaders\.set\(ACCESS_EMAIL_HEADER, email\)/);
  assert.match(cloudflareAccess, /jwtVerify\(/);
  assert.match(cloudflareAccess, /createRemoteJWKSet\(/);
  assert.match(server, /from\("operators"\)/);
  // S4: .eq("user_id", ...) を外して無条件で1件返す壊し方を検知する。
  assert.match(server, /\.eq\("user_id", normalizedEmail\)/);
  assert.match(server, /resolveOperator\(/);
  assert.match(server, /notFound\(\)/);
  // S5/🟡-3: ヘッダー欠落時に自分自身（/admin）へ redirect すると無限リダイレクトに
  // なるため、redirect() を使わないことをソースレベルでも固定する
  // （コメントの説明文中の「redirect」は許容し、実際の import / 呼び出しだけを見る）。
  assert.doesNotMatch(server, /import \{[^}]*\bredirect\b[^}]*\} from "next\/navigation"/);
  assert.doesNotMatch(server, /redirect\("\/admin"\)/);
  assert.doesNotMatch(server, /auth\.getUser\(\)/);
  assert.match(operatorSession, /status: "missing-email"/);
  assert.match(operatorSession, /status: "not-found"/);
  assert.match(admin, /requireOperator\(\)/);
  assert.match(layout, /requireOperator\(\)/);
  for (const section of sections) assert.match(section, /requireOperator\(\)/);
});

test('admin navigation uses UTAGE vocabulary', () => {
  for (const label of ['ファネル', 'メール配信', '会員サイト', 'ラベル', '管理メニュー']) assert.ok(layout.includes(label));
});
