import { requireOperator } from "@/lib/supabase/server";

import { createFunnel } from "../actions";
import { FunnelForm } from "../FunnelForm";

export const dynamic = "force-dynamic";

export default async function NewFunnelPage() {
  const { supabase, operator } = await requireOperator();
  const { data: products } = await supabase
    .from("products")
    .select("id,name")
    .eq("tenant_id", operator.tenant_id)
    .order("name", { ascending: true });

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>ファネルを作成</h1>
      <section className="admin-panel">
        <FunnelForm action={createFunnel} products={products ?? []} submitLabel="作成する" />
      </section>
    </main>
  );
}
