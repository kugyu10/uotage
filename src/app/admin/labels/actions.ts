"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

export async function createLabel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 100) throw new Error("ラベル名を入力してください");

  const { error } = await supabase.from("labels").insert({ tenant_id: operator.tenant_id, name });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/labels");
}

export async function renameLabel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!id) throw new Error("ラベルIDが不正です");
  if (!name || name.length > 100) throw new Error("ラベル名を入力してください");

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
