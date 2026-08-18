import Link from "next/link";

import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const { supabase, operator } = await requireOperator();
  const { data: products } = await supabase
    .from("products")
    .select("id,name,stripe_price_id,content_url")
    .eq("tenant_id", operator.tenant_id)
    .order("created_at", { ascending: false });

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>商品管理</h1>
      <div className="admin-toolbar">
        <Link href="/admin/products/new">+ 商品を作成</Link>
        <Link href="/admin/funnels">ファネル一覧</Link>
      </div>
      <section className="admin-panel">
        {(products ?? []).length === 0 ? (
          <p>まだ商品がありません。</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>商品名</th>
                <th>Stripe Price ID</th>
                <th>コースURL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(products ?? []).map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{product.stripe_price_id}</td>
                  <td>{product.content_url ?? "―"}</td>
                  <td><Link href={`/admin/products/${product.id}`}>編集</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
