"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

async function nextPosition(
  supabase: Awaited<ReturnType<typeof requireOperator>>["supabase"],
  tenantId: string,
  scenarioId: string,
) {
  const { data } = await supabase
    .from("step_messages")
    .select("position")
    .eq("tenant_id", tenantId)
    .eq("scenario_id", scenarioId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.position ?? -1) + 1;
}

/** ステップを末尾に追加し、そのまま編集画面へ遷移する。 */
export async function createStep(scenarioId: string) {
  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) throw new Error("シナリオが見つかりません。");

  const position = await nextPosition(supabase, operator.tenant_id, scenarioId);

  const { data: step, error } = await supabase
    .from("step_messages")
    .insert({
      tenant_id: operator.tenant_id,
      scenario_id: scenarioId,
      position,
      delay_minutes: 0,
      send_at_hour: null,
      subject: "",
      body: "",
      skip_if_purchased: true,
    })
    .select("id")
    .single();

  if (error || !step) {
    throw new Error("ステップの追加に失敗しました。");
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
  redirect(`/admin/mail/scenarios/${scenarioId}/steps/${step.id}`);
}

/** ステップの削除。削除後は残りのステップの position を 0 始まりに詰め直す。 */
export async function deleteStep(scenarioId: string, stepId: string) {
  const { supabase, operator } = await requireOperator();

  const { error } = await supabase
    .from("step_messages")
    .delete()
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId)
    .eq("id", stepId);
  if (error) throw new Error("ステップの削除に失敗しました。");

  await renumberSteps(supabase, operator.tenant_id, scenarioId);

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
}

/** 「上へ」「下へ」ボタンによる並び替え。隣接するステップと position を入れ替える。 */
export async function moveStep(scenarioId: string, stepId: string, direction: "up" | "down") {
  const { supabase, operator } = await requireOperator();

  const { data: steps } = await supabase
    .from("step_messages")
    .select("id, position")
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId)
    .order("position", { ascending: true });

  const ordered = steps ?? [];
  const index = ordered.findIndex((step) => step.id === stepId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || targetIndex < 0 || targetIndex >= ordered.length) return;

  const current = ordered[index];
  const target = ordered[targetIndex];

  await supabase
    .from("step_messages")
    .update({ position: target.position })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", current.id);
  await supabase
    .from("step_messages")
    .update({ position: current.position })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", target.id);

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
}

async function renumberSteps(
  supabase: Awaited<ReturnType<typeof requireOperator>>["supabase"],
  tenantId: string,
  scenarioId: string,
) {
  const { data: steps } = await supabase
    .from("step_messages")
    .select("id, position")
    .eq("tenant_id", tenantId)
    .eq("scenario_id", scenarioId)
    .order("position", { ascending: true });

  for (const [index, step] of (steps ?? []).entries()) {
    if (step.position !== index) {
      await supabase.from("step_messages").update({ position: index }).eq("tenant_id", tenantId).eq("id", step.id);
    }
  }
}
