"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

/** シナリオの新規作成。配信アカウント配下に position=0 の状態で作られる（ステップは別途追加）。 */
export async function createScenario(formData: FormData) {
  const { supabase, operator } = await requireOperator();

  const name = String(formData.get("name") ?? "").trim();
  const deliveryAccountId = String(formData.get("delivery_account_id") ?? "").trim();
  const funnelIdRaw = String(formData.get("funnel_id") ?? "").trim();
  const isActive = formData.get("is_active") === "on";

  if (!name || !deliveryAccountId) {
    throw new Error("シナリオ名と配信アカウントは必須です。");
  }

  const { data: scenario, error } = await supabase
    .from("scenarios")
    .insert({
      tenant_id: operator.tenant_id,
      delivery_account_id: deliveryAccountId,
      funnel_id: funnelIdRaw || null,
      name,
      is_active: isActive,
    })
    .select("id")
    .single();

  if (error || !scenario) {
    throw new Error("シナリオの作成に失敗しました。");
  }

  revalidatePath("/admin/mail");
  redirect(`/admin/mail/scenarios/${scenario.id}`);
}
