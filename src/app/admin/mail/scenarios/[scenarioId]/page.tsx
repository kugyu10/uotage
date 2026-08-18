import Link from "next/link";
import { notFound } from "next/navigation";

import { updateScenario } from "@/app/admin/mail/scenarios/[scenarioId]/actions";
import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ scenarioId: string }> }) {
  const { scenarioId } = await params;
  const { supabase, operator } = await requireOperator();

  const [{ data: scenario }, { data: funnels }, { data: account }] = await Promise.all([
    supabase
      .from("scenarios")
      .select("id, name, is_active, funnel_id, delivery_account_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", scenarioId)
      .maybeSingle(),
    supabase.from("funnels").select("id, name").eq("tenant_id", operator.tenant_id).order("created_at", { ascending: true }),
    supabase.from("delivery_accounts").select("id, name").eq("tenant_id", operator.tenant_id),
  ]);

  if (!scenario) notFound();

  const accountName = account?.find((row) => row.id === scenario.delivery_account_id)?.name ?? "";

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信 ／ {accountName}</p>
      <h1>{scenario.name}</h1>

      <nav className="admin-tabs">
        <Link href={`/admin/mail/scenarios/${scenarioId}/steps`} className="admin-tab-active">
          ステップ配信
        </Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/readers`}>読者一覧</Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/deliveries`}>送信済</Link>
      </nav>

      <section className="admin-panel">
        <h2>シナリオ設定</h2>
        <form action={updateScenario.bind(null, scenarioId)} className="admin-form">
          <label>
            シナリオ名
            <input name="name" type="text" required maxLength={120} defaultValue={scenario.name} />
          </label>
          <label>
            紐づくファネル
            <select name="funnel_id" defaultValue={scenario.funnel_id ?? ""}>
              <option value="">未選択</option>
              {(funnels ?? []).map((funnel) => (
                <option key={funnel.id} value={funnel.id}>
                  {funnel.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-checkbox">
            <input name="is_active" type="checkbox" defaultChecked={scenario.is_active} />
            配信を有効にする
          </label>
          <button type="submit">保存する</button>
        </form>
      </section>
    </main>
  );
}
