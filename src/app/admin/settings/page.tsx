import { requireOperator } from "@/lib/supabase/server";

export default async function Page() {
  await requireOperator();
  return <main className="admin-main"><p className="eyebrow">管理メニュー</p><h1>オペレーター・配信アカウント</h1>
    <section className="admin-panel"><p>実装中です。</p></section></main>;
}
