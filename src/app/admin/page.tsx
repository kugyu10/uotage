import Link from "next/link";

import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { supabase, operator } = await requireOperator();
  const [funnels, readers, deliveries, courses, labels] = await Promise.all([
    supabase.from("funnels").select("id", { count: "exact", head: true }).eq("tenant_id", operator.tenant_id),
    supabase.from("readers").select("id", { count: "exact", head: true }).eq("tenant_id", operator.tenant_id),
    supabase.from("deliveries").select("id", { count: "exact", head: true }).eq("tenant_id", operator.tenant_id).eq("status", "sent"),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("tenant_id", operator.tenant_id),
    supabase.from("labels").select("id", { count: "exact", head: true }).eq("tenant_id", operator.tenant_id),
  ]);
  const cards = [["ファネル", funnels.count], ["読者", readers.count], ["送信済", deliveries.count], ["コース", courses.count], ["ラベル", labels.count]];
  return <main className="admin-main"><p className="eyebrow">ファネル</p><h1>ダッシュボード</h1>
    <div className="admin-cards">{cards.map(([label, count]) => <article key={label}><span>{label}</span><strong>{count ?? 0}</strong></article>)}</div>
    <section className="admin-panel"><h2>はじめに</h2><p>ファネルと配信アカウントを設定し、シナリオにステップ配信を追加してください。</p>
      <div className="admin-toolbar">
        <Link href="/admin/funnels">ファネル一覧</Link>
        <Link href="/admin/products">商品管理</Link>
        <Link href="/admin/registration-paths">登録経路</Link>
      </div>
    </section>
  </main>;
}
