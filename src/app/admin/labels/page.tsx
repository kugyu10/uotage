import { requireOperator } from "@/lib/supabase/server";

import { createLabel, deleteLabel, renameLabel } from "./actions";

export const dynamic = "force-dynamic";

export default async function LabelsPage() {
  const { supabase, operator } = await requireOperator();
  const { data: labels } = await supabase
    .from("labels")
    .select("id,name,created_at,reader_labels(count)")
    .eq("tenant_id", operator.tenant_id)
    .order("name", { ascending: true });

  return (
    <main className="admin-main">
      <p className="eyebrow">ラベル</p>
      <h1>ラベル管理</h1>
      <section className="admin-panel">
        <h2>ラベルを作成する</h2>
        <form action={createLabel} className="admin-inline-form">
          <input type="text" name="name" placeholder="ラベル名" required maxLength={100} />
          <button type="submit">作成する</button>
        </form>
      </section>
      <section className="admin-panel">
        {(labels ?? []).length === 0 ? (
          <p>まだラベルがありません。</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ラベル名</th>
                <th>付与読者数</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(labels ?? []).map((label) => {
                const readerCount = Array.isArray(label.reader_labels)
                  ? Number(label.reader_labels[0]?.count ?? 0)
                  : 0;
                return (
                  <tr key={label.id}>
                    <td>
                      <form action={renameLabel} className="admin-inline-form">
                        <input type="hidden" name="id" defaultValue={label.id} />
                        <input type="text" name="name" defaultValue={label.name} required maxLength={100} />
                        <button type="submit">名称変更</button>
                      </form>
                    </td>
                    <td>{readerCount}人</td>
                    <td>
                      <form action={deleteLabel}>
                        <input type="hidden" name="id" defaultValue={label.id} />
                        <button type="submit" className="admin-danger">削除</button>
                      </form>
                    </td>
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
