import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

import { ImportWizard } from "./ImportWizard";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ scenarioId: string }> };

export default async function ImportScenarioPage({ params }: PageProps) {
  const { scenarioId } = await params;
  if (!isUuid(scenarioId)) notFound();

  const { supabase, operator } = await requireOperator();
  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, name")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) notFound();

  return (
    <main className="admin-main">
      <p className="eyebrow">メール配信</p>
      <h1>{scenario.name} への読者インポート</h1>
      <section className="admin-panel">
        <p>UTAGE互換の読者CSV（日本語ヘッダー）を取り込みます。必ずドライラン結果を確認してから実行してください。</p>
        <ImportWizard scenarioId={scenario.id} />
      </section>
    </main>
  );
}
