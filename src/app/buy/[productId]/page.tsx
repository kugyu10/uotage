import { notFound } from "next/navigation";

import { CheckoutButton } from "@/app/buy/[productId]/checkout-button";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export default async function BuyPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  if (!isUuid(productId)) notFound();

  const { data: product } = await createAdminClient().from("products")
    .select("id, name")
    .eq("tenant_id", defaultTenantId())
    .eq("id", productId)
    .maybeSingle();
  if (!product) notFound();

  return <main className="public-card-page"><section>
    <p className="eyebrow">オンライン講座</p>
    <h1>{product.name}</h1>
    <p>決済は Stripe の安全な決済画面で行われます。決済完了後、登録メールアドレスへご案内をお送りします。</p>
    <CheckoutButton productId={product.id} />
    <p className="legal"><a href="/privacy">プライバシーポリシー</a></p>
  </section></main>;
}
