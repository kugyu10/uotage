import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";

import { updateFunnel } from "../actions";
import { FunnelForm } from "../FunnelForm";

export const dynamic = "force-dynamic";

export default async function EditFunnelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, operator } = await requireOperator();

  const [{ data: funnel }, { data: products }, { data: scenarios }] = await Promise.all([
    supabase
      .from("funnels")
      .select("id,name,slug,trigger_type,product_id,deadline_hours,booking_url,is_active")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("products")
      .select("id,name")
      .eq("tenant_id", operator.tenant_id)
      .order("name", { ascending: true }),
    supabase
      .from("scenarios")
      .select("id,name")
      .eq("tenant_id", operator.tenant_id)
      .eq("funnel_id", id),
  ]);

  if (!funnel) notFound();

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>ファネルを編集</h1>
      <section className="admin-panel">
        <FunnelForm action={updateFunnel} products={products ?? []} initial={funnel} submitLabel="更新する" />
      </section>
      <section className="admin-panel">
        <h2>紐づくシナリオ</h2>
        {(scenarios ?? []).length === 0 ? (
          <p>このファネルに紐づくシナリオはまだありません。</p>
        ) : (
          <ul>
            {(scenarios ?? []).map((scenario) => <li key={scenario.id}>{scenario.name}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
