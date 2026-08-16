import { createClient } from "@supabase/supabase-js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const sessionId = option("session");
if (!sessionId?.startsWith("cs_test_")) {
  console.error("--session cs_test_... を指定してください。Stripe テスト Checkout Session のみ確認できます。");
  process.exit(64);
}

const tenantId = required("DEFAULT_TENANT_ID");
const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: purchase, error: purchaseError } = await supabase.from("purchases")
  .select("id, reader_id, product_id, amount, purchased_at")
  .eq("tenant_id", tenantId)
  .eq("stripe_session_id", sessionId)
  .maybeSingle();
if (purchaseError) throw purchaseError;
if (!purchase) {
  console.error("購入レコードがありません。Webhook の 200 応答と Stripe のイベント配信を確認してください。");
  process.exit(1);
}

const [productResult, labelsResult, scenariosResult, deliveriesResult] = await Promise.all([
  supabase.from("products").select("name").eq("tenant_id", tenantId).eq("id", purchase.product_id).maybeSingle(),
  supabase.from("reader_labels").select("label_id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("reader_id", purchase.reader_id),
  supabase.from("scenario_readers").select("id, deadline_at", { count: "exact" }).eq("tenant_id", tenantId).eq("reader_id", purchase.reader_id),
  supabase.from("deliveries").select("id, status").eq("tenant_id", tenantId).eq("reader_id", purchase.reader_id),
]);
for (const result of [productResult, labelsResult, scenariosResult, deliveriesResult]) {
  if (result.error) throw result.error;
}

console.log(JSON.stringify({
  purchase: { id: purchase.id, amount: purchase.amount, purchasedAt: purchase.purchased_at },
  product: productResult.data?.name ?? "<削除済み>",
  labelCount: labelsResult.count ?? 0,
  purchaseScenarioCount: scenariosResult.count ?? 0,
  deadlineAt: scenariosResult.data?.[0]?.deadline_at ?? null,
  deliveryStatusCounts: (deliveriesResult.data ?? []).reduce((counts, delivery) => {
    counts[delivery.status] = (counts[delivery.status] ?? 0) + 1;
    return counts;
  }, {}),
  deliveries: (deliveriesResult.data ?? []).map((delivery) => ({ id: delivery.id, status: delivery.status })),
}, null, 2));
