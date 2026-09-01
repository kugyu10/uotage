import { requireOperator } from "@/lib/supabase/server";

import { updateDeliveryAccount } from "./actions";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { owner: "所有者", operator: "担当者" };

function stripeMode(secretKey: string | undefined): "test" | "live" | "unknown" {
  if (!secretKey) return "unknown";
  if (secretKey.startsWith("sk_live_")) return "live";
  if (secretKey.startsWith("sk_test_")) return "test";
  return "unknown";
}

export default async function SettingsPage() {
  const { supabase, operator } = await requireOperator();
  const { data: auth } = await supabase.auth.getUser();

  const [{ data: operators }, { data: deliveryAccount }] = await Promise.all([
    supabase.from("operators").select("id,user_id,role").eq("tenant_id", operator.tenant_id).order("role", { ascending: true }),
    supabase
      .from("delivery_accounts")
      .select("id,name,from_name,from_email,legal_footer")
      .eq("tenant_id", operator.tenant_id)
      .limit(1)
      .maybeSingle(),
  ]);

  const hasStripeSecret = Boolean(process.env.STRIPE_SECRET_KEY);
  const hasStripeWebhook = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  const mode = stripeMode(process.env.STRIPE_SECRET_KEY);

  return (
    <main className="admin-main">
      <p className="eyebrow">管理メニュー</p>
      <h1>オペレーター・配信アカウント</h1>

      <section className="admin-panel">
        <h2>オペレーター一覧</h2>
        <table className="admin-table">
          <thead><tr><th>メールアドレス / ユーザーID</th><th>権限</th></tr></thead>
          <tbody>
            {(operators ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.user_id === auth.user?.id ? auth.user?.email ?? item.user_id : item.user_id}</td>
                <td>{ROLE_LABEL[item.role] ?? item.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="admin-panel">
        <h2>配信アカウント設定</h2>
        {!deliveryAccount ? <p>配信アカウントはまだ登録されていません。保存すると新規作成されます。</p> : null}
        <form action={updateDeliveryAccount} className="admin-form">
          <label>
            送信者名（from_name）
            <input type="text" name="from_name" defaultValue={deliveryAccount?.from_name ?? ""} required maxLength={200} />
          </label>
          <label>
            送信元メールアドレス（from_email）
            <input type="email" name="from_email" defaultValue={deliveryAccount?.from_email ?? ""} required />
          </label>
          <label>
            法定表記（legal_footer）
            <textarea name="legal_footer" defaultValue={deliveryAccount?.legal_footer ?? ""} required rows={4} />
          </label>
          <button type="submit">保存する</button>
        </form>
      </section>

      <section className="admin-panel">
        <h2>Stripe連携状態</h2>
        <p>
          STRIPE_SECRET_KEY:{" "}
          <span className={hasStripeSecret ? "admin-status-ok" : "admin-status-warn"}>
            {hasStripeSecret ? "設定済み" : "未設定"}
          </span>
        </p>
        <p>
          STRIPE_WEBHOOK_SECRET:{" "}
          <span className={hasStripeWebhook ? "admin-status-ok" : "admin-status-warn"}>
            {hasStripeWebhook ? "設定済み" : "未設定"}
          </span>
        </p>
        <p>
          モード:{" "}
          {mode === "live" ? "本番（live）" : mode === "test" ? "テスト（test）" : "不明"}
        </p>
      </section>
    </main>
  );
}
