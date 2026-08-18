"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/lib/supabase/server";

export async function updateDeliveryAccount(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const fromName = String(formData.get("from_name") ?? "").trim();
  const fromEmail = String(formData.get("from_email") ?? "").trim();
  const legalFooter = String(formData.get("legal_footer") ?? "").trim();

  if (!fromName || fromName.length > 200) throw new Error("送信者名を入力してください");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new Error("送信元メールアドレスが不正です");
  if (!legalFooter) throw new Error("法定表記（フッター）を入力してください");

  const { data: existing } = await supabase
    .from("delivery_accounts")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .limit(1)
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from("delivery_accounts")
        .update({ from_name: fromName, from_email: fromEmail, legal_footer: legalFooter })
        .eq("tenant_id", operator.tenant_id)
        .eq("id", existing.id)
    : await supabase.from("delivery_accounts").insert({
        tenant_id: operator.tenant_id,
        name: "メイン配信アカウント",
        from_name: fromName,
        from_email: fromEmail,
        legal_footer: legalFooter,
      });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/settings");
}
