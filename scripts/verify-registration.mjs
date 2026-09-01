/**
 * 実DBに対して register_reader の登録経路を往復させる検証スクリプト。
 *
 * 既存テストはSQLをソース文字列の正規表現でしか見ておらず、関数を一度も
 * 実行していなかった。その結果 register_reader は初版から
 * 42702 (column reference "email" is ambiguous) で必ず失敗していたのに、
 * テストは全件パスし続けていた。ここでは実際に呼んで振る舞いを確かめる。
 *
 * 使い方: npm run verify:registration [funnel-slug]
 *
 * 副作用と安全性:
 *   - 宛先は *.invalid.test（RFC 2606の予約TLD）。実在しないので万一
 *     送信されても誰にも届かない。
 *   - 作成した readers / purchases / scenario_readers / deliveries は
 *     finally で必ず削除し、最後に残存件数を表示する。
 *   - 1通目は register_reader が status='processing' で作る。この状態は
 *     claim_deliveries のスタック復旧（scheduled_at が10分以上前）に
 *     引っかかるまで配信ワーカーに拾われないため、数秒で片付ける本script
 *     では送信は発生しない。
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tenantId = process.env.DEFAULT_TENANT_ID;
for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: key,
  DEFAULT_TENANT_ID: tenantId,
})) {
  if (!value) throw new Error(`${name} が未設定です`);
}
const funnelSlug = process.argv[2] ?? "registration-test";

const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
async function api(method, path, body, prefer) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: prefer ? { ...headers, Prefer: prefer } : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}
const rpc = (name, body) => api("POST", `rpc/${name}`, body);
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (detail && !ok) console.log(`        ${detail}`);
  if (ok) passed += 1;
  else failed += 1;
}

const stamp = Date.now();
const buyerEmail = `verify-buyer-${stamp}@invalid.test`;
const plainEmail = `verify-plain-${stamp}@invalid.test`;
const createdReaderIds = [];

try {
  const funnel = await api(
    "GET",
    `funnels?select=id,product_id&tenant_id=eq.${tenantId}&slug=eq.${funnelSlug}&trigger_type=eq.registration&is_active=is.true`,
  );
  if (funnel.length === 0) throw new Error(`登録トリガーの有効なファネル '${funnelSlug}' が見つかりません`);

  // 「購入済みには送らない」の判定対象。ファネルに商品が未設定なら任意の購入でスキップされる。
  const products = await api("GET", `products?select=id&tenant_id=eq.${tenantId}&limit=1`);
  if (products.length === 0) throw new Error("検証用の商品が1件も存在しません");
  const productId = funnel[0].product_id ?? products[0].id;

  console.log(`\nファネル: ${funnelSlug} / 判定対象商品: ${productId}\n`);
  console.log("=== 購入済みの読者が初めて登録する（4.3-4「購入済みには送らない」）===");

  const [buyer] = await api(
    "POST",
    "readers",
    { tenant_id: tenantId, email: buyerEmail, name: null, access_token: token(), unsubscribe_token: token() },
    "return=representation",
  );
  createdReaderIds.push(buyer.id);
  await api("POST", "purchases", {
    tenant_id: tenantId,
    reader_id: buyer.id,
    product_id: productId,
    stripe_session_id: `cs_verify_${stamp}`,
    amount: 1000,
  });

  const [buyerResult] = await rpc("register_reader", {
    target_tenant_id: tenantId,
    target_funnel_slug: funnelSlug,
    reader_email: buyerEmail,
    reader_name: null,
    target_registration_path: null,
    generated_access_token: token(),
    generated_unsubscribe_token: token(),
  });
  check("subject を返さない（APIが即時送信できない）", buyerResult.subject === null, `subject=${JSON.stringify(buyerResult.subject)}`);
  check("body を返さない", buyerResult.body === null, `body=${JSON.stringify(buyerResult.body)}`);
  check("initial_delivery_id を返さない", buyerResult.initial_delivery_id === null, `id=${JSON.stringify(buyerResult.initial_delivery_id)}`);

  const buyerDeliveries = await api("GET", `deliveries?select=status,error_message&reader_id=eq.${buyer.id}`);
  const buyerStatuses = JSON.stringify(buyerDeliveries.map((row) => row.status));
  check("1通目が 'skipped' で確定している", buyerDeliveries.some((row) => row.status === "skipped"), `statuses=${buyerStatuses}`);
  check("processing のまま残っていない（スタック復旧で後から送られない）", !buyerDeliveries.some((row) => row.status === "processing"), `statuses=${buyerStatuses}`);

  console.log("\n=== 対照: 購入していない読者は従来どおり即時送信の材料が返る ===");
  const [plainResult] = await rpc("register_reader", {
    target_tenant_id: tenantId,
    target_funnel_slug: funnelSlug,
    reader_email: plainEmail,
    reader_name: null,
    target_registration_path: null,
    generated_access_token: token(),
    generated_unsubscribe_token: token(),
  });
  createdReaderIds.push(plainResult.reader_id);
  check(
    "subject を返す（スキップが効きすぎていない）",
    typeof plainResult.subject === "string" && plainResult.subject.length > 0,
    `subject=${JSON.stringify(plainResult.subject)}`,
  );
  check("initial_delivery_id を返す", typeof plainResult.initial_delivery_id === "string", `id=${plainResult.initial_delivery_id}`);
  const plainBefore = await api(
    "GET",
    `deliveries?select=id,status,scheduled_at&reader_id=eq.${plainResult.reader_id}&order=scheduled_at.asc`,
  );
  check("1通目が 'processing'（APIが即時送信する前提）", plainBefore[0]?.status === "processing", `status=${plainBefore[0]?.status}`);

  console.log("\n=== 重複登録の10分クールダウン（登録連打で送りつけられない）===");
  const [again] = await rpc("register_reader", {
    target_tenant_id: tenantId,
    target_funnel_slug: funnelSlug,
    reader_email: plainEmail,
    reader_name: null,
    target_registration_path: null,
    generated_access_token: token(),
    generated_unsubscribe_token: token(),
  });
  check("重複登録では subject を返さない（即時送信は新規のみ）", again.subject === null, `subject=${JSON.stringify(again.subject)}`);
  const plainAfter = await api(
    "GET",
    `deliveries?select=id,status,scheduled_at&reader_id=eq.${plainResult.reader_id}&order=scheduled_at.asc`,
  );
  check(
    "クールダウン内なので scheduled_at を積み直さない",
    plainAfter[0]?.scheduled_at === plainBefore[0]?.scheduled_at,
    `before=${plainBefore[0]?.scheduled_at} after=${plainAfter[0]?.scheduled_at}`,
  );
  check(
    "期限(deadline_at)がリセットされない",
    again.deadline_at === plainResult.deadline_at,
    `before=${plainResult.deadline_at} after=${again.deadline_at}`,
  );
} catch (error) {
  console.log(`\n実行エラー: ${error.message}`);
  failed += 1;
} finally {
  for (const readerId of createdReaderIds) {
    for (const table of ["deliveries", "scenario_readers", "reader_labels", "purchases"]) {
      await api("DELETE", `${table}?reader_id=eq.${readerId}`).catch((e) => console.log(`  後片付け(${table}): ${e.message}`));
    }
    await api("DELETE", `readers?id=eq.${readerId}`).catch((e) => console.log(`  後片付け(readers): ${e.message}`));
  }
  const leftover = await api("GET", "readers?select=id,email&email=like.verify-%25%40invalid.test").catch(() => []);
  console.log(`\n後片付け: 残存テスト読者 ${leftover.length}件${leftover.length ? ` ${JSON.stringify(leftover)}` : "（クリーン）"}`);
  console.log(`\n結果: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
}
