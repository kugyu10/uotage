import Link from "next/link";
import { notFound } from "next/navigation";

import { createStep, deleteStep, moveStep } from "@/app/admin/mail/scenarios/[scenarioId]/steps/actions";
import { timingModeFromStep } from "@/lib/mail-steps";
import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function timingLabel(step: { delay_minutes: number; send_at_hour: number | null }) {
  if (timingModeFromStep(step) === "immediate") return "シナリオ登録直後";
  const days = Math.floor(step.delay_minutes / 1440);
  const hour = step.send_at_hour ?? 9;
  return `${days}日後 ${String(hour).padStart(2, "0")}:00`;
}

export default async function Page({ params }: { params: Promise<{ scenarioId: string }> }) {
  const { scenarioId } = await params;
  const { supabase, operator } = await requireOperator();

  const [{ data: scenario }, { data: steps }, { data: labels }] = await Promise.all([
    supabase.from("scenarios").select("id, name").eq("tenant_id", operator.tenant_id).eq("id", scenarioId).maybeSingle(),
    supabase
      .from("step_messages")
      .select("id, position, delay_minutes, send_at_hour, subject, skip_if_purchased, grant_label_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("scenario_id", scenarioId)
      .order("position", { ascending: true }),
    supabase.from("labels").select("id, name").eq("tenant_id", operator.tenant_id),
  ]);

  if (!scenario) notFound();

  const labelNameById = new Map((labels ?? []).map((label) => [label.id, label.name]));
  const ordered = steps ?? [];

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信 ／ {scenario.name}</p>
      <h1>ステップ配信</h1>

      <nav className="admin-tabs">
        <Link href={`/admin/mail/scenarios/${scenarioId}/steps`} className="admin-tab-active">
          ステップ配信
        </Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/readers`}>読者一覧</Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/deliveries`}>送信済</Link>
      </nav>

      <section className="admin-panel">
        {ordered.length === 0 ? (
          <p>ステップはまだありません。</p>
        ) : (
          <ol className="admin-step-list">
            {ordered.map((step, index) => (
              <li key={step.id}>
                <div className="admin-step-summary">
                  <strong>{index + 1}. {step.subject || "(件名未設定)"}</strong>
                  <span className="admin-meta">{timingLabel(step)}</span>
                  {step.skip_if_purchased && <span className="admin-badge">購入済みには送らない</span>}
                  {step.grant_label_id && (
                    <span className="admin-badge">送信後にラベル付与: {labelNameById.get(step.grant_label_id) ?? ""}</span>
                  )}
                </div>
                <div className="admin-step-actions">
                  <form action={moveStep.bind(null, scenarioId, step.id, "up")}>
                    <button type="submit" className="button-secondary" disabled={index === 0}>
                      上へ
                    </button>
                  </form>
                  <form action={moveStep.bind(null, scenarioId, step.id, "down")}>
                    <button type="submit" className="button-secondary" disabled={index === ordered.length - 1}>
                      下へ
                    </button>
                  </form>
                  <Link href={`/admin/mail/scenarios/${scenarioId}/steps/${step.id}`} className="button-secondary">
                    編集
                  </Link>
                  <form action={deleteStep.bind(null, scenarioId, step.id)}>
                    <button type="submit" className="button-danger">
                      削除
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ol>
        )}

        <form action={createStep.bind(null, scenarioId)} className="admin-inline-form">
          <button type="submit">ステップを追加</button>
        </form>
      </section>
    </main>
  );
}
