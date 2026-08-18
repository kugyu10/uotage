import { requireOperator } from "@/lib/supabase/server";

import { createProduct } from "../actions";
import { ProductForm } from "../ProductForm";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const { supabase, operator } = await requireOperator();
  const [{ data: scenarios }, { data: labels }] = await Promise.all([
    supabase.from("scenarios").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
    supabase.from("labels").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
  ]);

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>商品を作成</h1>
      <section className="admin-panel">
        <ProductForm action={createProduct} scenarios={scenarios ?? []} labels={labels ?? []} submitLabel="作成する" />
      </section>
    </main>
  );
}
