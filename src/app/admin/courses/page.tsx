import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function CoursesPage() {
  const { supabase, operator } = await requireOperator();
  const [{ data: courses }, { data: purchases }] = await Promise.all([
    supabase
      .from("products")
      .select("id,name,content_url")
      .eq("tenant_id", operator.tenant_id)
      .not("content_url", "is", null)
      .order("name", { ascending: true }),
    supabase
      .from("purchases")
      .select("id,purchased_at,readers(name,email),products(name)")
      .eq("tenant_id", operator.tenant_id)
      .order("purchased_at", { ascending: false }),
  ]);

  return (
    <main className="admin-main">
      <p className="eyebrow">会員サイト</p>
      <h1>コース・受講生</h1>
      <section className="admin-panel">
        <h2>コース一覧</h2>
        {(courses ?? []).length === 0 ? (
          <p>コースURLが設定された商品はまだありません。商品管理でコースURLを設定してください。</p>
        ) : (
          <table className="admin-table">
            <thead><tr><th>コース名</th><th>コースURL</th></tr></thead>
            <tbody>
              {(courses ?? []).map((course) => (
                <tr key={course.id}>
                  <td>{course.name}</td>
                  <td><a href={course.content_url ?? "#"} target="_blank" rel="noreferrer">{course.content_url}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="admin-panel">
        <h2>受講生一覧</h2>
        {(purchases ?? []).length === 0 ? (
          <p>まだ購入履歴がありません。</p>
        ) : (
          <table className="admin-table">
            <thead><tr><th>読者</th><th>商品</th><th>購入日時</th></tr></thead>
            <tbody>
              {(purchases ?? []).map((purchase) => {
                const reader = Array.isArray(purchase.readers) ? purchase.readers[0] : purchase.readers;
                const product = Array.isArray(purchase.products) ? purchase.products[0] : purchase.products;
                return (
                  <tr key={purchase.id}>
                    <td>{reader?.name ?? reader?.email ?? "―"}</td>
                    <td>{product?.name ?? "―"}</td>
                    <td>{new Date(purchase.purchased_at).toLocaleString("ja-JP")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
