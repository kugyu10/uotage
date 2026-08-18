import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const DELIVERY_STATUSES = ["queued", "processing", "sent", "skipped", "failed"] as const;

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: "送信待ち",
  processing: "送信処理中",
  sent: "送信済み",
  skipped: "スキップ",
  failed: "失敗",
};

function first(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ja-JP", { hour12: false });
}

export default async function ScenarioDeliveriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ scenarioId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { scenarioId } = await params;
  if (!isUuid(scenarioId)) notFound();
  const query = await searchParams;
  const statusFilter = first(query.status);

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) notFound();

  let deliveriesQuery = supabase
    .from("deliveries")
    .select(
      "id, status, scheduled_at, sent_at, attempt_count, error_message, readers(email), step_messages(subject), scenario_readers!inner(scenario_id)",
    )
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_readers.scenario_id", scenarioId)
    .order("scheduled_at", { ascending: false });
  if ((DELIVERY_STATUSES as readonly string[]).includes(statusFilter)) {
    deliveriesQuery = deliveriesQuery.eq("status", statusFilter);
  }

  const { data: rows } = await deliveriesQuery;
  type DeliveryRow = {
    id: string;
    status: string;
    scheduled_at: string;
    sent_at: string | null;
    attempt_count: number;
    error_message: string | null;
    readers: { email: string } | null;
    step_messages: { subject: string } | null;
  };
  const deliveries = (rows ?? []) as unknown as DeliveryRow[];

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信</p>
      <h1>{scenario.name} — 送信済</h1>
      <p>
        <Link href={`/admin/mail/scenarios/${scenarioId}`}>← シナリオ詳細に戻る</Link>
      </p>

      <section className="admin-panel">
        <h2>絞り込み</h2>
        <form method="get" className="admin-filters">
          <label>
            ステータス
            <select name="status" defaultValue={statusFilter}>
              <option value="">すべて</option>
              {DELIVERY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {DELIVERY_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">絞り込む</button>
        </form>
      </section>

      <section className="admin-panel">
        <h2>配信ログ（{deliveries.length}件・新しい順）</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>読者メール</th>
                <th>件名</th>
                <th>ステータス</th>
                <th>送信予定</th>
                <th>送信日時</th>
                <th>試行回数</th>
                <th>エラー</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.readers?.email ?? "—"}</td>
                  <td>{delivery.step_messages?.subject ?? "（削除されたステップ）"}</td>
                  <td>{DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status}</td>
                  <td>{formatDateTime(delivery.scheduled_at)}</td>
                  <td>{formatDateTime(delivery.sent_at)}</td>
                  <td>{delivery.attempt_count}</td>
                  <td>{delivery.error_message ?? "—"}</td>
                </tr>
              ))}
              {deliveries.length === 0 && (
                <tr>
                  <td colSpan={7}>該当する配信ログがありません。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
