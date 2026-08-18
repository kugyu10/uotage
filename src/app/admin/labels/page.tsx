import { requireOperator } from "@/lib/supabase/server";

export default async function Page() {
  await requireOperator();
  return <main className="admin-main"><p className="eyebrow">ラベル</p><h1>ラベル管理</h1>
    <section className="admin-panel"><p>実装中です。</p></section></main>;
}
