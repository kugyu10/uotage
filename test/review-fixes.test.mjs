import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const unsubscribeRoute = await read('../src/app/api/unsubscribe/route.ts');
const webhook = await read('../src/app/api/stripe/webhook/route.ts');
const loginForm = await read('../src/app/login/login-form.tsx');
const labelActions = await read('../src/app/admin/labels/actions.ts');
const nextConfig = await read('../next.config.ts');
const edge = await read('../supabase/functions/dispatch-deliveries/index.ts');
const proxy = await read('../src/proxy.ts');
const exportRows = await read('../src/lib/csv/export-rows.ts');

test('one-click unsubscribe answers GET as well as POST', () => {
  // RFC 8058 非対応クライアントは List-Unsubscribe の URI を GET で開く。
  assert.match(unsubscribeRoute, /export (async )?function GET\(/);
  assert.match(unsubscribeRoute, /export async function POST\(/);
  // GET は解除を実行しない（リンクスキャナのプリフェッチで解除されるため）。
  const getBody = unsubscribeRoute.slice(unsubscribeRoute.search(/export (async )?function GET\(/));
  assert.doesNotMatch(getBody, /unsubscribed_at/);
  assert.match(getBody, /status: 303/);
  // Location は相対パス。プロキシ配下では request.url のホストが公開ドメインと
  // 一致しないため、そこから絶対URLを組むと内部ホストへ飛ばしうる。
  assert.match(getBody, /\? `\/unsubscribe\?u=\$\{encodeURIComponent\(token\)\}`/);
  assert.match(getBody, /: "\/unsubscribe"/);
  assert.match(getBody, /headers: \{ Location: location \}/);
});

test('the webhook returns 2xx for events that a retry cannot fix', () => {
  // 4xx/5xx を返すと Stripe が最大3日リトライし続ける。
  assert.match(webhook, /ignored: "payment_incomplete_or_metadata_missing"/);
  assert.match(webhook, /ignored: "tenant_mismatch"/);
  // 署名検証の失敗だけは 400 のまま（不正なリクエストなので受け取らない）。
  assert.match(webhook, /return new Response\("署名を検証できません。", \{ status: 400 \}\)/);
  // RPC の失敗は 5xx でリトライさせる。
  assert.match(webhook, /return new Response\("購入処理に失敗しました。", \{ status: 500 \}\)/);
});

test('login does not create auth users for uninvited addresses', () => {
  assert.match(loginForm, /shouldCreateUser: false/);
  // 成否で文言を出し分けるとアドレスの登録有無が判定できてしまう。
  assert.doesNotMatch(loginForm, /error \?/);
});

test('label names cannot contain the CSV list separator', () => {
  // 「ラベル」列はカンマ区切りなので、名前にカンマがあると往復で分裂する。
  assert.match(labelActions, /name\.includes\(","\)/);
  assert.match(labelActions, /function parseLabelName/);
  const usages = labelActions.match(/parseLabelName\(formData\)/g) ?? [];
  assert.equal(usages.length, 2, '作成と改名の両方で検証する必要がある');
});

test('csv export sanitizes the header row, not just the data cells', () => {
  // カスタム項目の列名はインポートCSVのヘッダー由来＝外部入力。
  assert.match(exportRows, /buildCsv\(headers\.map\(sanitizeCsvCell\)/);
});

test('security headers are set for every route', () => {
  assert.match(nextConfig, /async headers\(\)/);
  for (const header of ['Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Permissions-Policy']) {
    assert.match(nextConfig, new RegExp(`key: "${header}"`), `${header} が未設定`);
  }
  // no-referrer はドメイン制限付きの動画埋め込みを壊す。
  assert.doesNotMatch(nextConfig, /value: "no-referrer"/);
});

test('the cron secret is compared in constant time', () => {
  assert.match(edge, /function secretMatches\(/);
  assert.match(edge, /diff \|= left\[i\] \^ right\[i\]/);
  assert.doesNotMatch(edge, /!== `Bearer \$\{required\("CRON_SECRET"\)\}`/);
});

test('the proxy does not build a redirect target from the request path', () => {
  // next パラメータはどこも参照しておらず、許可リストなしでは
  // オープンリダイレクトの入口になりうる。
  assert.doesNotMatch(proxy, /searchParams\.set\("next"/);
  assert.match(proxy, /NextResponse\.redirect\(new URL\("\/login", request\.url\)\)/);
});
