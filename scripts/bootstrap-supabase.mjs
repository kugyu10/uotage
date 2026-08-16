import { createClient } from "@supabase/supabase-js";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const config = {
  tenantName: option("tenant-name", "UOTAGE"),
  accountName: option("account-name", "メイン配信アカウント"),
  fromName: option("from-name", process.env.RESEND_FROM_NAME),
  fromEmail: option("from-email", process.env.RESEND_FROM_EMAIL),
  legalFooter: option("legal-footer", [process.env.NEXT_PUBLIC_OPERATOR_NAME, process.env.NEXT_PUBLIC_CONTACT_EMAIL, process.env.NEXT_PUBLIC_OPERATOR_ADDRESS].filter(Boolean).join("\n")),
  funnelName: option("funnel-name", "登録テストファネル"),
  funnelSlug: option("funnel-slug", "registration-test"),
  deadlineHours: Number(option("deadline-hours", "72")),
  bookingUrl: option("booking-url", process.env.NEXT_PUBLIC_BOOKING_URL),
  scenarioName: option("scenario-name", "登録テストシナリオ"),
  subject: option("subject", "ご登録ありがとうございます"),
  body: option("body", "{{name}}様、ご登録ありがとうございます。\n\n{{offer_url}}\n\n{{unsubscribe_url}}"),
};

if (![config.fromName, config.fromEmail, config.legalFooter, config.bookingUrl].every(Boolean)
  || !Number.isInteger(config.deadlineHours) || config.deadlineHours < 0) {
  console.error("必須: --from-name --from-email --legal-footer --booking-url（deadline-hours は0以上の整数）");
  process.exit(64);
}
for (const [name, value] of [["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY]]) {
  if (!value) { console.error(`${name} が未設定です`); process.exit(65); }
}

console.log(JSON.stringify({ action: "bootstrap", ...config, body: "<omitted>" }, null, 2));
if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、同じ引数に --confirm を付けてください。");
  process.exit(66);
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: tenant, error: tenantError } = await supabase.from("tenants").insert({ name: config.tenantName }).select("id").single();
if (tenantError) throw tenantError;
const tenantId = tenant.id;
const fail = async (error) => { if (error) throw error; };
try {
  const { data: account, error } = await supabase.from("delivery_accounts").insert({ tenant_id: tenantId, name: config.accountName, from_name: config.fromName, from_email: config.fromEmail, legal_footer: config.legalFooter }).select("id").single(); await fail(error);
  const { data: funnel, error: funnelError } = await supabase.from("funnels").insert({ tenant_id: tenantId, name: config.funnelName, slug: config.funnelSlug, trigger_type: "registration", deadline_hours: config.deadlineHours, booking_url: config.bookingUrl }).select("id").single(); await fail(funnelError);
  const { data: scenario, error: scenarioError } = await supabase.from("scenarios").insert({ tenant_id: tenantId, delivery_account_id: account.id, funnel_id: funnel.id, name: config.scenarioName }).select("id").single(); await fail(scenarioError);
  const { error: stepError } = await supabase.from("step_messages").insert({ tenant_id: tenantId, scenario_id: scenario.id, position: 0, delay_minutes: 0, subject: config.subject, body: config.body }); await fail(stepError);
  console.log(`DEFAULT_TENANT_ID=${tenantId}`);
} catch (error) {
  await supabase.from("step_messages").delete().eq("tenant_id", tenantId);
  await supabase.from("scenarios").delete().eq("tenant_id", tenantId);
  await supabase.from("funnels").delete().eq("tenant_id", tenantId);
  await supabase.from("delivery_accounts").delete().eq("tenant_id", tenantId);
  await supabase.from("tenants").delete().eq("id", tenantId);
  throw error;
}
