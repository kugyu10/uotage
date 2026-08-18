import { requireOperator } from "@/lib/supabase/server";

export default async function Page() {
  await requireOperator();
  return <main className="admin-main"><p className="eyebrow">会員サイト</p><h1>コース・受講生</h1>
    <section className="admin-panel"><p>実装中です。</p></section></main>;
}
