import { requireOperator } from "@/lib/supabase/server";

export default async function Page() {
  await requireOperator();
  return <main className="admin-main"><p className="eyebrow">メール配信</p><h1>シナリオ・ステップ配信</h1>
    <section className="admin-panel"><p>実装中です。</p></section></main>;
}
