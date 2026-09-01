import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const amount = Number(option("amount", "100"));
const config = {
  tenantId: required("DEFAULT_TENANT_ID"),
  productName: option("name", "購入フロー疎通テスト（削除可）"),
  amount,
  currency: option("currency", "jpy").toLowerCase(),
  contentUrl: option("content-url", "https://example.invalid/uotage-test-content"),
  labelName: option("label-name", "決済疎通テスト"),
  funnelName: option("funnel-name", "決済疎通テストファネル"),
  funnelSlug: option("funnel-slug", "purchase-test"),
  scenarioName: option("scenario-name", "決済疎通テストシナリオ"),
  deadlineHours: Number(option("deadline-hours", "168")),
  bookingUrl: option("booking-url", process.env.NEXT_PUBLIC_BOOKING_URL),
  delayMinutes: Number(option("delay-minutes", "0")),
};

if (!Number.isSafeInteger(config.amount) || config.amount < 50
  || !Number.isInteger(config.deadlineHours) || config.deadlineHours < 0
  || !Number.isInteger(config.delayMinutes) || config.delayMinutes < 0
  || !config.bookingUrl) {
  console.error("amount は50以上の整数、deadline-hours/delay-minutes は0以上の整数、booking-url は必須です。");
  process.exit(64);
}
try { new URL(config.contentUrl); new URL(config.bookingUrl); } catch { console.error("content-url と booking-url は URL 形式で指定してください。"); process.exit(64); }

const stripeKey = required("STRIPE_SECRET_KEY");
if (!stripeKey.startsWith("sk_test_")) {
  console.error("このコマンドは Stripe テストキー (sk_test_) でのみ実行できます。");
  process.exit(65);
}
const appUrl = required("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(JSON.stringify({ action: "bootstrap-stripe-test-product", ...config, purchaseUrl: `${appUrl}/buy/<product-id>` }, null, 2));
if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、同じ引数に --confirm を付けてください。Stripe テスト商品と Supabase の確認用データを作成します。");
  process.exit(66);
}

const { data: account, error: accountError } = await supabase.from("delivery_accounts")
  .select("id").eq("tenant_id", config.tenantId).limit(1).maybeSingle();
if (accountError) throw accountError;
if (!account) throw new Error("対象テナントに配信アカウントがありません。先に bootstrap-supabase を完了してください。");

// 同じ確認用ファネルがあれば、外部の Stripe 商品を新規作成せず既存データを返す。
const { data: existingFunnel, error: existingFunnelError } = await supabase.from("funnels")
  .select("id, product_id").eq("tenant_id", config.tenantId).eq("slug", config.funnelSlug).maybeSingle();
if (existingFunnelError) throw existingFunnelError;
if (existingFunnel?.product_id) {
  const { data: existingProduct, error: existingProductError } = await supabase.from("products")
    .select("id, stripe_price_id").eq("tenant_id", config.tenantId).eq("id", existingFunnel.product_id).maybeSingle();
  if (existingProductError) throw existingProductError;
  if (!existingProduct) throw new Error("既存の購入ファネルの商品が見つかりません。管理画面で設定を確認してください。");
  console.log("既存の確認用商品を利用します。新しい Stripe 商品や Supabase データは作成しません。");
  console.log(`PRODUCT_ID=${existingProduct.id}`);
  console.log(`STRIPE_PRICE_ID=${existingProduct.stripe_price_id}`);
  console.log(`PURCHASE_URL=${appUrl}/buy/${existingProduct.id}`);
  process.exit(0);
}

const stripe = new Stripe(stripeKey);
const created = {};
async function fail(error) { if (error) throw error; }
async function rollback() {
  if (created.stepId) await supabase.from("step_messages").delete().eq("id", created.stepId);
  if (created.productId) await supabase.from("products").update({ post_purchase_scenario_id: null, post_purchase_label_id: null }).eq("id", created.productId);
  if (created.scenarioId) await supabase.from("scenarios").delete().eq("id", created.scenarioId);
  if (created.funnelId) await supabase.from("funnels").delete().eq("id", created.funnelId);
  if (created.productId) await supabase.from("products").delete().eq("id", created.productId);
  if (created.labelId) await supabase.from("labels").delete().eq("id", created.labelId);
  if (created.priceId) await stripe.prices.update(created.priceId, { active: false });
  if (created.stripeProductId) await stripe.products.update(created.stripeProductId, { active: false });
}

try {
  const stripeProduct = await stripe.products.create({ name: config.productName, metadata: { uotage_test: "true" } });
  created.stripeProductId = stripeProduct.id;
  const price = await stripe.prices.create({ product: stripeProduct.id, unit_amount: config.amount, currency: config.currency });
  created.priceId = price.id;

  const { data: label, error: labelError } = await supabase.from("labels")
    .insert({ tenant_id: config.tenantId, name: config.labelName }).select("id").single();
  await fail(labelError); created.labelId = label.id;
  const { data: product, error: productError } = await supabase.from("products")
    .insert({ tenant_id: config.tenantId, name: config.productName, stripe_price_id: price.id, content_url: config.contentUrl })
    .select("id").single();
  await fail(productError); created.productId = product.id;
  const { data: funnel, error: funnelError } = await supabase.from("funnels").insert({
    tenant_id: config.tenantId, name: config.funnelName, slug: config.funnelSlug, trigger_type: "purchase",
    product_id: product.id, deadline_hours: config.deadlineHours, booking_url: config.bookingUrl,
  }).select("id").single();
  await fail(funnelError); created.funnelId = funnel.id;
  const { data: scenario, error: scenarioError } = await supabase.from("scenarios").insert({
    tenant_id: config.tenantId, delivery_account_id: account.id, funnel_id: funnel.id, name: config.scenarioName,
  }).select("id").single();
  await fail(scenarioError); created.scenarioId = scenario.id;
  const { data: step, error: stepError } = await supabase.from("step_messages").insert({
    tenant_id: config.tenantId, scenario_id: scenario.id, position: 0, delay_minutes: config.delayMinutes,
    subject: "【テスト】ご購入ありがとうございます", body: "{{name}}様\n\n決済フローの疎通テストです。\n\n{{offer_url}}\n\n{{unsubscribe_url}}",
  }).select("id").single();
  await fail(stepError); created.stepId = step.id;
  const { error: updateError } = await supabase.from("products").update({
    post_purchase_scenario_id: scenario.id, post_purchase_label_id: label.id,
  }).eq("id", product.id).eq("tenant_id", config.tenantId);
  await fail(updateError);

  console.log(`PRODUCT_ID=${product.id}`);
  console.log(`STRIPE_PRICE_ID=${price.id}`);
  console.log(`PURCHASE_URL=${appUrl}/buy/${product.id}`);
} catch (error) {
  await rollback().catch(() => {});
  throw error;
}
