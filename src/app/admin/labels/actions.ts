"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

/**
 * CSV の「ラベル」列はカンマ区切り（要件定義書 10.1/10.2）なので、
 * ラベル名自体にカンマを含めるとエクスポート→インポートの往復で
 * 別々のラベルに分裂する。名前の側で禁止して往復を無損失にする。
 */
function parseLabelName(formData: FormData): string {
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 100) throw new Error("ラベル名を入力してください");
  if (name.includes(",")) throw new Error("ラベル名にカンマは使用できません");
  return name;
}

export async function createLabel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const name = parseLabelName(formData);

  const { error } = await supabase.from("labels").insert({ tenant_id: operator.tenant_id, name });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/labels");
}

export async function renameLabel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("ラベルIDが不正です");
  const name = parseLabelName(formData);

  const { error } = await supabase
    .from("labels")
    .update({ name })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/labels");
}

export async function deleteLabel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("ラベルIDが不正です");

  const { error } = await supabase
    .from("labels")
    .delete()
    .eq("tenant_id", operator.tenant_id)
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/labels");
}
