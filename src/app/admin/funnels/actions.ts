"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isHttpUrl } from "@/lib/safe-url";
import { requireOperator } from "@/lib/supabase/server";

type FunnelInput = {
  name: string;
  slug: string;
  triggerType: string;
  productId: string | null;
  deadlineHours: number;
  bookingUrl: string | null;
  isActive: boolean;
};

function parseFunnelInput(formData: FormData): FunnelInput {
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const triggerType = String(formData.get("trigger_type") ?? "");
  const productId = String(formData.get("product_id") ?? "").trim();
  const deadlineHours = Number(formData.get("deadline_hours") ?? "");
  const bookingUrl = String(formData.get("booking_url") ?? "").trim();
  const isActive = formData.get("is_active") === "on";

  if (!name || name.length > 200) throw new Error("名称を入力してください");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new Error("スラッグは半角英数字とハイフンで入力してください");
  }
  if (triggerType !== "registration" && triggerType !== "purchase") {
    throw new Error("トリガー種別を選択してください");
  }
  if (!Number.isFinite(deadlineHours) || deadlineHours < 0) {
    throw new Error("期限は0以上の数値で入力してください");
  }
  if (triggerType === "purchase" && !productId) {
    throw new Error("購入トリガーには対象商品が必要です");
  }
  if (bookingUrl && !isHttpUrl(bookingUrl)) {
    throw new Error("予約URLは http(s) のURLを入力してください");
  }

  return {
    name,
    slug,
    triggerType,
    // 登録トリガーでも任意で「対象商品(訴求する商品)」を持てる。
    // 「購入済みには送らない」(4.3-4) の判定対象になる。
    productId: productId || null,
    deadlineHours: Math.trunc(deadlineHours),
    bookingUrl: bookingUrl || null,
    isActive,
  };
}

export async function createFunnel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const input = parseFunnelInput(formData);

  if (input.productId) {
    const { data: product } = await supabase
      .from("products")
      .select("id")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", input.productId)
      .maybeSingle();
    if (!product) throw new Error("対象商品が見つかりません");
  }

  const { error } = await supabase.from("funnels").insert({
    tenant_id: operator.tenant_id,
    name: input.name,
    slug: input.slug,
    trigger_type: input.triggerType,
    product_id: input.productId,
    deadline_hours: input.deadlineHours,
    booking_url: input.bookingUrl,
    is_active: input.isActive,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/funnels");
  redirect("/admin/funnels");
}

export async function updateFunnel(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("ファネルIDが不正です");
  const input = parseFunnelInput(formData);

  if (input.productId) {
    const { data: product } = await supabase
      .from("products")
      .select("id")
      .eq("tenant_id", operator.tenant_id)
      .eq("id", input.productId)
      .maybeSingle();
    if (!product) throw new Error("対象商品が見つかりません");
  }

  const { error } = await supabase
    .from("funnels")
    .update({
      name: input.name,
      slug: input.slug,
      trigger_type: input.triggerType,
      product_id: input.productId,
      deadline_hours: input.deadlineHours,
      booking_url: input.bookingUrl,
      is_active: input.isActive,
    })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/funnels");
  revalidatePath(`/admin/funnels/${id}`);
  redirect("/admin/funnels");
}
