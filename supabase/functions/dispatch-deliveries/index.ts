// Supabase Edge Function (Deno)。外部APIはこの関数が明示的に起動された時だけ呼ぶ。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Delivery = {
  delivery_id: string; attempt_count: number; recipient: string; reader_name: string | null;
  access_token: string; unsubscribe_token: string; subject: string; body: string;
  from_name: string; from_email: string; legal_footer: string; funnel_slug: string | null;
  booking_url: string | null; deadline_at: string; product_id: string | null;
  tenant_id: string; reader_id: string; grant_label_id: string | null;
};

const required = (name: string) => {
  const value = Deno.env.get(name); if (!value) throw new Error(`${name} is not configured`); return value;
};
const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const replace = (body: string, values: Record<string, string>) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(key, value), body);

async function idempotencyKey(items: Delivery[]) {
  const value = items.map((item) => item.delivery_id).sort().join(",");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `deliveries-${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (request) => {
  if (request.headers.get("authorization") !== `Bearer ${required("CRON_SECRET")}`) return new Response("Unauthorized", { status: 401 });
  const targetDeliveryId = request.headers.get("x-uotage-delivery-id");
  if (targetDeliveryId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetDeliveryId)) {
    return new Response("Invalid delivery id", { status: 400 });
  }
  const appUrl = required("APP_URL").replace(/\/$/, "");
  const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
  const { data, error } = await supabase.rpc("claim_deliveries", {
    batch_limit: targetDeliveryId ? 1 : 500,
    target_delivery_id: targetDeliveryId,
  });
  if (error) return Response.json({ error: "claim failed" }, { status: 500 });
  // 初回メール(src/lib/mail.ts)と同じ日本時間表記に合わせる。
  const deadlineFormat = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });
  let sent = 0; let failed = 0;
  for (const batch of chunks((data ?? []) as Delivery[], 100)) {
    const messages = batch.map((item) => {
      const offerUrl = item.funnel_slug ? `${appUrl}/offer/${encodeURIComponent(item.funnel_slug)}?token=${encodeURIComponent(item.access_token)}` : appUrl;
      const unsubscribeUrl = `${appUrl}/unsubscribe?u=${encodeURIComponent(item.unsubscribe_token)}`;
      const memberUrl = item.product_id ? `${appUrl}/course/${item.product_id}?token=${encodeURIComponent(item.access_token)}` : appUrl;
      const body = replace(item.body, {
        "{{name}}": item.reader_name ?? "", "{{offer_url}}": offerUrl,
        "{{booking_url}}": item.booking_url ?? "", "{{deadline}}": deadlineFormat.format(new Date(item.deadline_at)),
        "{{unsubscribe_url}}": unsubscribeUrl, "{{member_url}}": memberUrl,
      });
      return { from: `${item.from_name} <${item.from_email}>`, to: [item.recipient], subject: item.subject,
        text: `${body}\n\n${item.legal_footer}\n${unsubscribeUrl}`,
        headers: { "List-Unsubscribe": `<${appUrl}/api/unsubscribe?u=${encodeURIComponent(item.unsubscribe_token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
    });
    try {
      const response = await fetch("https://api.resend.com/emails/batch", { method: "POST", headers: {
        authorization: `Bearer ${required("RESEND_API_KEY")}`, "content-type": "application/json",
        "Idempotency-Key": await idempotencyKey(batch),
      }, body: JSON.stringify(messages) });
      if (!response.ok) throw new Error(`Resend status ${response.status}`);
      const result = await response.json() as { data?: Array<{ id: string }> };
      if (!result.data || result.data.length !== batch.length) throw new Error("Unexpected Resend batch response");
      await Promise.all(batch.map((item, index) => supabase.from("deliveries").update({ status: "sent", sent_at: new Date().toISOString(),
        resend_message_id: result.data?.[index]?.id, processing_started_at: null }).eq("id", item.delivery_id).eq("status", "processing")));
      sent += batch.length;
      // アクション管理(4.2.2): 送信後に付与するラベル。付与失敗は送信自体を巻き戻さない。
      const grants = batch.filter((item) => item.grant_label_id);
      if (grants.length > 0) {
        const { error: grantError } = await supabase.from("reader_labels").upsert(
          grants.map((item) => ({ tenant_id: item.tenant_id, reader_id: item.reader_id, label_id: item.grant_label_id })),
          { onConflict: "reader_id,label_id", ignoreDuplicates: true },
        );
        if (grantError) console.error("[dispatch-deliveries] grant label failed", grantError.message);
      }
    } catch (batchError) {
      await Promise.all(batch.map((item) => supabase.from("deliveries").update({
        status: item.attempt_count >= 3 ? "failed" : "queued", processing_started_at: null,
        error_message: batchError instanceof Error ? batchError.message.slice(0, 500) : "batch failed",
      }).eq("id", item.delivery_id).eq("status", "processing")));
      failed += batch.length;
    }
  }
  return Response.json({ claimed: data?.length ?? 0, sent, failed });
});
