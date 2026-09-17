"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

/**
 * ステップを末尾に追加し、そのまま編集画面へ遷移する。
 * position の採番は append_step_message に委ねる。TS 側で max(position) を
 * 読んでから insert すると、同時追加で position が衝突する。
 */
export async function createStep(scenarioId: string) {
  const { supabase, operator } = await requireOperator();

  await assertScenarioOwnership(supabase, operator.tenant_id, scenarioId);

  // append_step_message は security invoker で「呼び出し元の RLS がテナント越えを
  // 弾く」前提だが、#9 で requireOperator() は service role クライアント（RLS 迂回）
  // になったためその前提は崩れている。RPC 呼び出し前の assertScenarioOwnership で
  // テナント境界を明示的に確認する。
  const { data: newStepId, error } = await supabase.rpc("append_step_message", {
    target_scenario_id: scenarioId,
  });
  if (error || !newStepId) {
    throw new Error("ステップの追加に失敗しました。");
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
  redirect(`/admin/mail/scenarios/${scenarioId}/steps/${newStepId}`);
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

/**
 * 「上へ」「下へ」ボタンによる並び替え。隣接するステップと position を入れ替える。
 * 隣の特定と入れ替えを move_step_message に委ねる。UPDATE を2本に分けると、
 * 間で失敗したときに position が重複したまま残る。
 */
export async function moveStep(scenarioId: string, stepId: string, direction: "up" | "down") {
  const { supabase, operator } = await requireOperator();

  await assertScenarioOwnership(supabase, operator.tenant_id, scenarioId);

  const { error } = await supabase.rpc("move_step_message", {
    target_scenario_id: scenarioId,
    target_step_id: stepId,
    move_direction: direction,
  });
  if (error) throw new Error("ステップの並び替えに失敗しました。");

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
}

/**
 * scenarioId が呼び出し元オペレーターのテナントに属するかを検証する。
 * append_step_message / move_step_message は security invoker で RLS に
 * テナント境界を委ねているが、requireOperator() は service role クライアント
 * （RLS 迂回）を返すため、RPC を呼ぶ前にここで明示的に検証する必要がある。
 */
async function assertScenarioOwnership(
  supabase: Awaited<ReturnType<typeof requireOperator>>["supabase"],
  tenantId: string,
  scenarioId: string,
) {
  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) {
    throw new Error("シナリオが見つかりません。");
  }
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
