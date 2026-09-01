import Link from "next/link";

import { createScenario } from "@/app/admin/mail/actions";
import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { supabase, operator } = await requireOperator();

  const [{ data: accounts }, { data: scenarios }, { data: funnels }] = await Promise.all([
    supabase
      .from("delivery_accounts")
      .select("id, name, channel, from_name, from_email")
      .eq("tenant_id", operator.tenant_id)
      .order("created_at", { ascending: true }),
    supabase
      .from("scenarios")
      .select("id, name, is_active, delivery_account_id, funnel_id")
      .eq("tenant_id", operator.tenant_id)
      .order("created_at", { ascending: true }),
    supabase
      .from("funnels")
      .select("id, name")
      .eq("tenant_id", operator.tenant_id)
      .order("created_at", { ascending: true }),
  ]);

  const funnelNameById = new Map((funnels ?? []).map((funnel) => [funnel.id, funnel.name]));

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信</p>
      <h1>配信アカウント・シナリオ</h1>

      {(accounts ?? []).length === 0 && (
        <section className="admin-panel">
          <p>配信アカウントが未設定です。先に配信アカウントを用意してください。</p>
        </section>
      )}

      {(accounts ?? []).map((account) => {
        const accountScenarios = (scenarios ?? []).filter((scenario) => scenario.delivery_account_id === account.id);
        return (
          <section className="admin-panel" key={account.id}>
            <h2>{account.name}</h2>
            <p className="admin-meta">
              {account.channel === "email" ? "メール" : account.channel === "line" ? "LINE" : "メール + LINE"} ／{" "}
              {account.from_name} &lt;{account.from_email}&gt;
            </p>

            {accountScenarios.length === 0 ? (
              <p>シナリオはまだありません。</p>
            ) : (
              <ul className="admin-list">
                {accountScenarios.map((scenario) => (
                  <li key={scenario.id}>
                    <Link href={`/admin/mail/scenarios/${scenario.id}`}>{scenario.name}</Link>
                    <span className="admin-badge">{scenario.is_active ? "配信中" : "停止中"}</span>
                    <span className="admin-meta">
                      {scenario.funnel_id ? funnelNameById.get(scenario.funnel_id) ?? "" : "ファネル未紐づけ"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <details className="admin-inline-form">
              <summary>シナリオを作成</summary>
              <form action={createScenario} className="admin-form">
                <input type="hidden" name="delivery_account_id" value={account.id} />
                <label>
                  シナリオ名
                  <input name="name" type="text" required maxLength={120} />
                </label>
                <label>
                  紐づくファネル
                  <select name="funnel_id" defaultValue="">
                    <option value="">未選択</option>
                    {(funnels ?? []).map((funnel) => (
                      <option key={funnel.id} value={funnel.id}>
                        {funnel.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="admin-checkbox">
                  <input name="is_active" type="checkbox" defaultChecked />
                  配信を有効にする
                </label>
                <button type="submit">作成する</button>
              </form>
            </details>
          </section>
        );
      })}
    </main>
  );
}
