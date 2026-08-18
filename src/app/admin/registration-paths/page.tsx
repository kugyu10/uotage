import Link from "next/link";

import { requireOperator } from "@/lib/supabase/server";

import { createRegistrationPath, deleteRegistrationPath } from "./actions";

export const dynamic = "force-dynamic";

export default async function RegistrationPathsPage() {
  const { supabase, operator } = await requireOperator();
  const [{ data: paths }, { data: funnels }, { data: labels }] = await Promise.all([
    supabase
      .from("registration_paths")
      .select("id,path,name,funnel_id,label_id")
      .eq("tenant_id", operator.tenant_id)
      .order("created_at", { ascending: false }),
    supabase.from("funnels").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
    supabase.from("labels").select("id,name").eq("tenant_id", operator.tenant_id).order("name", { ascending: true }),
  ]);

  const funnelNameById = new Map((funnels ?? []).map((funnel) => [funnel.id, funnel.name]));
  const labelNameById = new Map((labels ?? []).map((label) => [label.id, label.name]));

  return (
    <main className="admin-main">
      <p className="eyebrow">ファネル</p>
      <h1>登録経路</h1>
      <p>登録フォームのURLパラメータ（登録経路）ごとに、発行する経路名と付与するラベルを設定します。</p>
      <section className="admin-panel">
        <h2>経路を発行する</h2>
        <form action={createRegistrationPath} className="admin-inline-form">
          <select name="funnel_id" required defaultValue="">
            <option value="" disabled>ファネルを選択</option>
            {(funnels ?? []).map((funnel) => (
              <option key={funnel.id} value={funnel.id}>{funnel.name}</option>
            ))}
          </select>
          <input type="text" name="path" placeholder="経路パス（x_1 など）" required pattern="[a-zA-Z0-9_-]{1,64}" />
          <input type="text" name="name" placeholder="経路名" required maxLength={200} />
          <select name="label_id" defaultValue="">
            <option value="">ラベルなし</option>
            {(labels ?? []).map((label) => (
              <option key={label.id} value={label.id}>{label.name}</option>
            ))}
          </select>
          <button type="submit">発行する</button>
        </form>
      </section>
      <section className="admin-panel">
        {(paths ?? []).length === 0 ? (
          <p>まだ登録経路がありません。</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ファネル</th>
                <th>経路パス</th>
                <th>経路名</th>
                <th>付与ラベル</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(paths ?? []).map((path) => (
                <tr key={path.id}>
                  <td>{funnelNameById.get(path.funnel_id) ?? "―"}</td>
                  <td>{path.path}</td>
                  <td>{path.name}</td>
                  <td>{path.label_id ? labelNameById.get(path.label_id) ?? "―" : "―"}</td>
                  <td>
                    <form action={deleteRegistrationPath}>
                      <input type="hidden" name="id" defaultValue={path.id} />
                      <button type="submit" className="admin-danger">削除</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p><Link href="/admin/funnels">ファネル一覧へ戻る</Link></p>
    </main>
  );
}
