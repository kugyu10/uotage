import "server-only";

import Stripe from "stripe";

import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const input = await request.json().catch(() => null) as { productId?: unknown } | null;
  const productId = typeof input?.productId === "string" ? input.productId : "";
  if (!isUuid(productId)) {
    return Response.json({ error: "商品を確認してください。" }, { status: 400 });
  }
  const { data: product } = await createAdminClient().from("products")
    .select("id, stripe_price_id").eq("tenant_id", defaultTenantId()).eq("id", productId).maybeSingle();
  if (!product) return Response.json({ error: "商品が見つかりません。" }, { status: 404 });

  const appUrl = publicEnv.appUrl.replace(/\/$/, "");
  const stripe = new Stripe(serverEnv.stripeSecretKey);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: product.stripe_price_id, quantity: 1 }],
    metadata: { product_id: product.id, tenant_id: defaultTenantId() },
    success_url: `${appUrl}/purchase-complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/`,
  });
  if (!session.url) return Response.json({ error: "決済を開始できません。" }, { status: 502 });
  return Response.json({ url: session.url });
}
