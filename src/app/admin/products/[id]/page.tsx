import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";

import { updateProduct } from "../actions";
import { ProductForm } from "../ProductForm";

export const dynamic = "force-dynamic";

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, operator } = await requireOperator();

  const [{ data: product }, { data: scenarios }, { data: labels }] = await Promise.all([
    supabase
      .from("products")
      .select("id,name,stripe_price_id,content_url,post_purchase_scenario_id,post_purchase_label_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", id)
      .maybeSingle(),
    supabase.from("scenarios").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
    supabase.from("labels").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
  ]);

  if (!product) notFound();

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>商品を編集</h1>
      <section className="admin-panel">
        <ProductForm
          action={updateProduct}
          scenarios={scenarios ?? []}
          labels={labels ?? []}
          initial={product}
          submitLabel="更新する"
        />
      </section>
    </main>
  );
}
