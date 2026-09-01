"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

/** シナリオ設定（名称・紐づくファネル・有効フラグ）の更新。 */
export async function updateScenario(scenarioId: string, formData: FormData) {
  const { supabase, operator } = await requireOperator();

  const name = String(formData.get("name") ?? "").trim();
  const funnelIdRaw = String(formData.get("funnel_id") ?? "").trim();
  const isActive = formData.get("is_active") === "on";

  if (!name) {
    throw new Error("シナリオ名は必須です。");
  }

  const { error } = await supabase
    .from("scenarios")
    .update({ name, funnel_id: funnelIdRaw || null, is_active: isActive })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId);

  if (error) {
    throw new Error("シナリオの更新に失敗しました。");
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}`);
  revalidatePath("/admin/mail");
}
