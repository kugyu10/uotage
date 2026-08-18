import Link from "next/link";
import { notFound } from "next/navigation";

import { sendTestStep, updateStep } from "@/app/admin/mail/scenarios/[scenarioId]/steps/[stepId]/actions";
import { StepEditor } from "@/app/admin/mail/scenarios/[scenarioId]/steps/[stepId]/step-editor";
import { timingModeFromStep } from "@/lib/mail-steps";
import { requireOperator } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ scenarioId: string; stepId: string }> }) {
  const { scenarioId, stepId } = await params;
  const { supabase, operator } = await requireOperator();

  const [{ data: scenario }, { data: step }, { data: labels }] = await Promise.all([
    supabase.from("scenarios").select("id, name").eq("tenant_id", operator.tenant_id).eq("id", scenarioId).maybeSingle(),
    supabase
      .from("step_messages")
      .select("id, position, delay_minutes, send_at_hour, subject, body, skip_if_purchased, grant_label_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("scenario_id", scenarioId)
      .eq("id", stepId)
      .maybeSingle(),
    supabase.from("labels").select("id, name").eq("tenant_id", operator.tenant_id).order("created_at", { ascending: true }),
  ]);

  if (!scenario || !step) notFound();

  const timingMode = timingModeFromStep(step);

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信 ／ {scenario.name}</p>
      <h1>ステップ {step.position + 1} を編集</h1>

      <nav className="admin-tabs">
        <Link href={`/admin/mail/scenarios/${scenarioId}/steps`} className="admin-tab-active">
          ステップ配信
        </Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/readers`}>読者一覧</Link>
        <Link href={`/admin/mail/scenarios/${scenarioId}/deliveries`}>送信済</Link>
      </nav>

      <p>
        <Link href={`/admin/mail/scenarios/${scenarioId}/steps`}>← ステップ一覧に戻る</Link>
      </p>

      <section className="admin-panel">
        <StepEditor
          labels={labels ?? []}
          initial={{
            subject: step.subject,
            body: step.body,
            timingMode,
            daysAfter: timingMode === "days_after" ? Math.max(1, Math.floor(step.delay_minutes / 1440)) : 1,
            sendHour: step.send_at_hour ?? 9,
            skipIfPurchased: step.skip_if_purchased,
            grantLabelId: step.grant_label_id ?? "",
          }}
          updateStepAction={updateStep.bind(null, scenarioId, stepId)}
          sendTestStepAction={sendTestStep.bind(null, scenarioId)}
        />
      </section>
    </main>
  );
}
