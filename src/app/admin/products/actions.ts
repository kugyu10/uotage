"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";

type ProductInput = {
  name: string;
  stripePriceId: string;
  contentUrl: string | null;
  postPurchaseScenarioId: string | null;
  postPurchaseLabelId: string | null;
};

function parseProductInput(formData: FormData): ProductInput {
  const name = String(formData.get("name") ?? "").trim();
  const stripePriceId = String(formData.get("stripe_price_id") ?? "").trim();
  const contentUrl = String(formData.get("content_url") ?? "").trim();
  const postPurchaseScenarioId = String(formData.get("post_purchase_scenario_id") ?? "").trim();
  const postPurchaseLabelId = String(formData.get("post_purchase_label_id") ?? "").trim();

  if (!name || name.length > 200) throw new Error("商品名を入力してください");
  if (!stripePriceId) throw new Error("Stripe Price IDを入力してください");

  return {
    name,
    stripePriceId,
    contentUrl: contentUrl || null,
    postPurchaseScenarioId: postPurchaseScenarioId || null,
    postPurchaseLabelId: postPurchaseLabelId || null,
  };
}

async function assertBelongsToTenant(
  supabase: Awaited<ReturnType<typeof requireOperator>>["supabase"],
  tenantId: string,
  table: "scenarios" | "labels",
  id: string | null,
  message: string,
) {
  if (!id) return;
  const { data } = await supabase.from(table).select("id").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!data) throw new Error(message);
}

export async function createProduct(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const input = parseProductInput(formData);

  await assertBelongsToTenant(supabase, operator.tenant_id, "scenarios", input.postPurchaseScenarioId, "購入後シナリオが見つかりません");
  await assertBelongsToTenant(supabase, operator.tenant_id, "labels", input.postPurchaseLabelId, "購入後ラベルが見つかりません");

  const { error } = await supabase.from("products").insert({
    tenant_id: operator.tenant_id,
    name: input.name,
    stripe_price_id: input.stripePriceId,
    content_url: input.contentUrl,
    post_purchase_scenario_id: input.postPurchaseScenarioId,
    post_purchase_label_id: input.postPurchaseLabelId,
  });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/products");
  redirect("/admin/products");
}

export async function updateProduct(formData: FormData): Promise<void> {
  const { supabase, operator } = await requireOperator();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("商品IDが不正です");
  const input = parseProductInput(formData);

  await assertBelongsToTenant(supabase, operator.tenant_id, "scenarios", input.postPurchaseScenarioId, "購入後シナリオが見つかりません");
  await assertBelongsToTenant(supabase, operator.tenant_id, "labels", input.postPurchaseLabelId, "購入後ラベルが見つかりません");

  const { error } = await supabase
    .from("products")
    .update({
      name: input.name,
      stripe_price_id: input.stripePriceId,
      content_url: input.contentUrl,
      post_purchase_scenario_id: input.postPurchaseScenarioId,
      post_purchase_label_id: input.postPurchaseLabelId,
    })
    .eq("tenant_id", operator.tenant_id)
    .eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/admin/products");
  revalidatePath(`/admin/products/${id}`);
  redirect("/admin/products");
}
