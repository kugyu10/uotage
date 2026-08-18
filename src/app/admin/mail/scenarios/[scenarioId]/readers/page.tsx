import Link from "next/link";
import { notFound } from "next/navigation";

import { AddReaderForm } from "@/app/admin/mail/scenarios/[scenarioId]/readers/add-reader-form";
import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ja-JP", { hour12: false });
}

function formatRegistrationPath(path: string | null): string {
  if (!path) return "—";
  return path === "manual" ? "個別追加（手動）" : path;
}

const STATUS_LABEL: Record<string, string> = {
  active: "配信中",
  completed: "完了",
  stopped: "停止",
};

export default async function ScenarioReadersPage({
  params,
  searchParams,
}: {
  params: Promise<{ scenarioId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { scenarioId } = await params;
  if (!isUuid(scenarioId)) notFound();
  const query = await searchParams;

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) notFound();

  const emailFilter = first(query.email).toLowerCase();
  const pathFilter = first(query.path).toLowerCase();
  const labelFilter = first(query.label);
  const purchasedFilter = first(query.purchased);
  const unsubscribedFilter = first(query.unsubscribed);

  const { data: labels } = await supabase
    .from("labels")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .order("name", { ascending: true });

  let readersQuery = supabase
    .from("scenario_readers")
    .select("id, registered_at, registration_path, deadline_at, status, readers!inner(id, email, name, unsubscribed_at)")
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId)
    .order("registered_at", { ascending: false });
  if (emailFilter) readersQuery = readersQuery.ilike("readers.email", `%${emailFilter}%`);
  if (pathFilter) readersQuery = readersQuery.ilike("registration_path", `%${pathFilter}%`);
  if (unsubscribedFilter === "yes") readersQuery = readersQuery.not("readers.unsubscribed_at", "is", null);
  if (unsubscribedFilter === "no") readersQuery = readersQuery.is("readers.unsubscribed_at", null);

  const { data: enrollmentRows } = await readersQuery;
  type EnrollmentRow = {
    id: string;
    registered_at: string;
    registration_path: string | null;
    deadline_at: string;
    status: string;
    readers: { id: string; email: string; name: string | null; unsubscribed_at: string | null };
  };
  let rows = (enrollmentRows ?? []) as unknown as EnrollmentRow[];

  if (labelFilter) {
    const { data: granted } = await supabase
      .from("reader_labels")
      .select("reader_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("label_id", labelFilter);
    const grantedIds = new Set((granted ?? []).map((row) => row.reader_id as string));
    rows = rows.filter((row) => grantedIds.has(row.readers.id));
  }

  if (purchasedFilter === "yes" || purchasedFilter === "no") {
    const { data: purchases } = await supabase
      .from("purchases")
      .select("reader_id")
      .eq("tenant_id", operator.tenant_id);
    const purchasedIds = new Set((purchases ?? []).map((row) => row.reader_id as string));
    rows = rows.filter((row) =>
      purchasedFilter === "yes" ? purchasedIds.has(row.readers.id) : !purchasedIds.has(row.readers.id),
    );
  }

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信</p>
      <h1>{scenario.name} — 読者一覧</h1>
      <p>
        <Link href={`/admin/mail/scenarios/${scenarioId}`}>← シナリオ詳細に戻る</Link>
        {" ／ "}
        <Link href={`/admin/mail/scenarios/${scenarioId}/import`}>CSV一括追加</Link>
        {" ／ "}
        <a href={`/admin/mail/scenarios/${scenarioId}/export`}>CSVエクスポート</a>
      </p>

      <section className="admin-panel">
        <h2>検索・絞り込み</h2>
        <form method="get" className="admin-filters">
          <label>
            メールアドレス
            <input type="text" name="email" defaultValue={first(query.email)} placeholder="部分一致" />
          </label>
          <label>
            登録経路
            <input type="text" name="path" defaultValue={first(query.path)} placeholder="部分一致（manual = 個別追加）" />
          </label>
          <label>
            ラベル
            <select name="label" defaultValue={labelFilter}>
              <option value="">すべて</option>
              {(labels ?? []).map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            購入状況
            <select name="purchased" defaultValue={purchasedFilter}>
              <option value="">すべて</option>
              <option value="yes">購入あり</option>
              <option value="no">購入なし</option>
            </select>
          </label>
          <label>
            解除状況
            <select name="unsubscribed" defaultValue={unsubscribedFilter}>
              <option value="">すべて</option>
              <option value="no">配信中</option>
              <option value="yes">解除済み</option>
            </select>
          </label>
          <button type="submit">検索</button>
        </form>
      </section>

      <section className="admin-panel">
        <h2>個別追加</h2>
        <AddReaderForm scenarioId={scenarioId} />
      </section>

      <section className="admin-panel">
        <h2>読者一覧（{rows.length}件）</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>メールアドレス</th>
                <th>名前</th>
                <th>登録日時</th>
                <th>期限</th>
                <th>ステータス</th>
                <th>登録経路</th>
                <th>解除状況</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.readers.email}</td>
                  <td>{row.readers.name ?? "—"}</td>
                  <td>{formatDateTime(row.registered_at)}</td>
                  <td>{formatDateTime(row.deadline_at)}</td>
                  <td>{STATUS_LABEL[row.status] ?? row.status}</td>
                  <td>{formatRegistrationPath(row.registration_path)}</td>
                  <td>{row.readers.unsubscribed_at ? "解除済み" : "配信中"}</td>
                  <td>
                    <Link href={`/admin/mail/scenarios/${scenarioId}/readers/${row.readers.id}`}>詳細</Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>該当する読者がいません。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
