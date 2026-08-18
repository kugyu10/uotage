import Link from "next/link";
import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

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

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: "送信待ち",
  processing: "送信処理中",
  sent: "送信済み",
  skipped: "スキップ",
  failed: "失敗",
};

export default async function ScenarioReaderDetailPage({
  params,
}: {
  params: Promise<{ scenarioId: string; readerId: string }>;
}) {
  const { scenarioId, readerId } = await params;
  if (!isUuid(scenarioId) || !isUuid(readerId)) notFound();

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) notFound();

  const { data: enrollmentRow } = await supabase
    .from("scenario_readers")
    .select(
      "id, registered_at, registration_path, deadline_at, status, readers!inner(id, email, name, unsubscribed_at)",
    )
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId)
    .eq("reader_id", readerId)
    .maybeSingle();
  if (!enrollmentRow) notFound();

  type Enrollment = {
    id: string;
    registered_at: string;
    registration_path: string | null;
    deadline_at: string;
    status: string;
    readers: { id: string; email: string; name: string | null; unsubscribed_at: string | null };
  };
  const enrollment = enrollmentRow as unknown as Enrollment;
  const reader = enrollment.readers;

  const [{ data: labelRows }, { data: purchaseRows }, { data: deliveryRows }] = await Promise.all([
    supabase
      .from("reader_labels")
      .select("granted_at, labels(name)")
      .eq("tenant_id", operator.tenant_id)
      .eq("reader_id", readerId)
      .order("granted_at", { ascending: false }),
    supabase
      .from("purchases")
      .select("purchased_at, amount, products(name)")
      .eq("tenant_id", operator.tenant_id)
      .eq("reader_id", readerId)
      .order("purchased_at", { ascending: false }),
    supabase
      .from("deliveries")
      .select("id, status, scheduled_at, sent_at, attempt_count, error_message, step_messages(subject, position)")
      .eq("tenant_id", operator.tenant_id)
      .eq("scenario_reader_id", enrollment.id)
      .order("scheduled_at", { ascending: true }),
  ]);

  type LabelRow = { granted_at: string; labels: { name: string } | null };
  type PurchaseRow = { purchased_at: string; amount: number | null; products: { name: string } | null };
  type DeliveryRow = {
    id: string;
    status: string;
    scheduled_at: string;
    sent_at: string | null;
    attempt_count: number;
    error_message: string | null;
    step_messages: { subject: string; position: number } | null;
  };
  const labels = (labelRows ?? []) as unknown as LabelRow[];
  const purchases = (purchaseRows ?? []) as unknown as PurchaseRow[];
  const deliveries = (deliveryRows ?? []) as unknown as DeliveryRow[];

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信</p>
      <h1>{scenario.name} — 読者詳細</h1>
      <p>
        <Link href={`/admin/mail/scenarios/${scenarioId}/readers`}>← 読者一覧に戻る</Link>
        {" / "}
        <Link href={`/admin/mail/scenarios/${scenarioId}`}>シナリオ詳細</Link>
      </p>

      <section className="admin-panel">
        <h2>基本情報</h2>
        <dl className="admin-dl">
          <dt>メールアドレス</dt>
          <dd>{reader.email}</dd>
          <dt>名前</dt>
          <dd>{reader.name ?? "—"}</dd>
          <dt>登録日時</dt>
          <dd>{formatDateTime(enrollment.registered_at)}</dd>
          <dt>期限</dt>
          <dd>{formatDateTime(enrollment.deadline_at)}</dd>
          <dt>ステータス</dt>
          <dd>{STATUS_LABEL[enrollment.status] ?? enrollment.status}</dd>
          <dt>登録経路</dt>
          <dd>{formatRegistrationPath(enrollment.registration_path)}</dd>
          <dt>解除状況</dt>
          <dd>{reader.unsubscribed_at ? `解除済み（${formatDateTime(reader.unsubscribed_at)}）` : "配信中（未解除）"}</dd>
        </dl>
      </section>

      <section className="admin-panel">
        <h2>付与ラベル</h2>
        {labels.length === 0 ? (
          <p>付与されているラベルはありません。</p>
        ) : (
          <ul>
            {labels.map((label, index) => (
              <li key={index}>
                {label.labels?.name ?? "（削除済みラベル）"} — 付与日時: {formatDateTime(label.granted_at)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel">
        <h2>購入状況</h2>
        {purchases.length === 0 ? (
          <p>購入履歴はありません。</p>
        ) : (
          <ul>
            {purchases.map((purchase, index) => (
              <li key={index}>
                {purchase.products?.name ?? "（削除済み商品）"} — 購入日時: {formatDateTime(purchase.purchased_at)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel">
        <h2>送信履歴（このシナリオ）</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>件名</th>
                <th>ステータス</th>
                <th>送信予定</th>
                <th>送信日時</th>
                <th>エラー</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.step_messages?.subject ?? "（削除されたステップ）"}</td>
                  <td>{DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status}</td>
                  <td>{formatDateTime(delivery.scheduled_at)}</td>
                  <td>{formatDateTime(delivery.sent_at)}</td>
                  <td>{delivery.error_message ?? "—"}</td>
                </tr>
              ))}
              {deliveries.length === 0 && (
                <tr>
                  <td colSpan={5}>送信履歴はありません。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
