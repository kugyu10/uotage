"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

const PATH_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function createRegistrationPath(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const funnelId = String(formData.get("funnel_id") ?? "").trim();
  const path = String(formData.get("path") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const labelId = String(formData.get("label_id") ?? "").trim();

  if (!funnelId) throw new Error("ファネルを選択してください");
  if (!PATH_PATTERN.test(path)) throw new Error("経路パスは半角英数字・アンダースコア・ハイフンで入力してください");
  if (!name || name.length > 200) throw new Error("経路名を入力してください");

  const { data: funnel } = await supabase
    .from("funnels")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", funnelId)
    .maybeSingle();
  if (!funnel) throw new Error("ファネルが見つかりません");

  let resolvedLabelId: string | null = null;
  if (labelId) {
    const { data: label } = await supabase
      .from("labels")
      .select("id")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", labelId)
      .maybeSingle();
    if (!label) throw new Error("ラベルが見つかりません");
    resolvedLabelId = label.id;
  }

  const { error } = await supabase.from("registration_paths").insert({
    tenant_id: operator.tenant_id,
    funnel_id: funnelId,
    path,
    name,
    label_id: resolvedLabelId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/registration-paths");
}

export async function deleteRegistrationPath(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("登録経路IDが不正です");

  const { error } = await supabase
    .from("registration_paths")
    .delete()
    .eq("tenant_id", operator.tenant_id)
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/registration-paths");
}
