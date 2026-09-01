import "server-only";

import Stripe from "stripe";

import { serverEnv } from "@/lib/env";
import { createUrlToken } from "@/lib/registration";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("署名がありません。", { status: 400 });
  const stripe = new Stripe(serverEnv.stripeSecretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, serverEnv.stripeWebhookSecret);
  } catch (error) {
    console.error("[stripe-webhook] 署名検証に失敗", {
      message: error instanceof Error ? error.message : String(error),
    });
    return new Response("署名を検証できません。", { status: 400 });
  }
  if (event.type !== "checkout.session.completed") return Response.json({ received: true });

  const session = event.data.object;
  const email = session.customer_details?.email?.trim().toLowerCase();
  const productId = session.metadata?.product_id;
  // ここから下の「処理しない」判定は、いずれも再送しても結果が変わらない。
  // 2xx 以外を返すと Stripe が最大3日リトライし続け、エンドポイントの
  // 失敗率が汚れて本当の障害が埋もれるため 200 で確定させる。
  // 一時的な失敗(RPCエラー)だけ 5xx を返してリトライさせる。
  if (!email || !productId || session.payment_status !== "paid") {
    // コンビニ決済など、支払い完了前に checkout.session.completed が届く非同期決済。
    return Response.json({ received: true, ignored: "payment_incomplete_or_metadata_missing" });
  }
  // Checkout作成時のmetadataと現在の既定テナントが一致する場合だけ処理する。
  if (session.metadata?.tenant_id !== defaultTenantId()) {
    console.warn("[stripe-webhook] テナント不一致のセッションを無視", {
      eventId: event.id, sessionId: session.id,
    });
    return Response.json({ received: true, ignored: "tenant_mismatch" });
  }
  const { error } = await createAdminClient().rpc("process_stripe_purchase", {
    target_tenant_id: defaultTenantId(), product: productId,
    stripe_session: session.id, buyer_email: email,
    buyer_name: session.customer_details?.name ?? null,
    paid_amount: session.amount_total,
    purchased_timestamp: new Date(event.created * 1000).toISOString(),
    generated_access_token: createUrlToken(),
    generated_unsubscribe_token: createUrlToken(),
  });
  if (error) {
    console.error("[stripe-webhook] 購入処理に失敗", {
      eventId: event.id,
      sessionId: session.id,
      productId,
      message: error.message,
    });
    return new Response("購入処理に失敗しました。", { status: 500 });
  }
  return Response.json({ received: true });
}
