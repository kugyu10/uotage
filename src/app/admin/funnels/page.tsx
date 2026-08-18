import Link from "next/link";

import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function FunnelsPage() {
  const { supabase, operator } = await requireOperator();
  const [{ data: funnels }, { data: scenarios }] = await Promise.all([
    supabase
      .from("funnels")
      .select("id,name,slug,trigger_type,deadline_hours,is_active")
      .eq("tenant_id", operator.tenant_id)
      .order("created_at", { ascending: false }),
    supabase
      .from("scenarios")
      .select("id,name,funnel_id")
      .eq("tenant_id", operator.tenant_id),
  ]);

  const scenarioNamesByFunnel = new Map<string, string[]>();
  for (const scenario of scenarios ?? []) {
    if (!scenario.funnel_id) continue;
    const names = scenarioNamesByFunnel.get(scenario.funnel_id) ?? [];
    names.push(scenario.name);
    scenarioNamesByFunnel.set(scenario.funnel_id, names);
  }

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>ファネル一覧</h1>
      <div className="admin-toolbar">
        <Link href="/admin/funnels/new">+ ファネルを作成</Link>
        <Link href="/admin/products">商品管理</Link>
        <Link href="/admin/registration-paths">登録経路</Link>
      </div>
      <section className="admin-panel">
        {(funnels ?? []).length === 0 ? (
          <p>まだファネルがありません。</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>スラッグ</th>
                <th>トリガー</th>
                <th>期限</th>
                <th>公開状態</th>
                <th>紐づくシナリオ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(funnels ?? []).map((funnel) => (
                <tr key={funnel.id}>
                  <td>{funnel.name}</td>
                  <td>{funnel.slug}</td>
                  <td>{funnel.trigger_type === "purchase" ? "購入" : "登録"}</td>
                  <td>{funnel.deadline_hours}時間</td>
                  <td>{funnel.is_active ? "公開中" : "停止中"}</td>
                  <td>{(scenarioNamesByFunnel.get(funnel.id) ?? []).join("、") || "―"}</td>
                  <td><Link href={`/admin/funnels/${funnel.id}`}>編集</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
