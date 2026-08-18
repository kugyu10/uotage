import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env";
import { sendInitialMail } from "@/lib/mail";
import { allowRegistration } from "@/lib/rate-limit";
import { createUrlToken, parseRegistrationInput } from "@/lib/registration";

export const runtime = "nodejs";

type Enrollment = {
  email: string; name: string | null; access_token: string; unsubscribe_token: string;
  funnel_slug: string; deadline_at: string; subject: string | null; body: string | null;
  initial_delivery_id: string | null; product_id: string | null;
  reader_id: string; initial_grant_label_id: string | null;
};

export async function POST(request: Request) {
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowRegistration(clientKey)) {
    return Response.json({ error: "しばらく待ってから再度お試しください。" }, { status: 429 });
  }

  let input;
  try {
    input = parseRegistrationInput(await request.json());
  } catch {
    return Response.json({ error: "入力内容を確認してください。" }, { status: 400 });
  }
  if (input.website) return Response.json({ ok: true }, { status: 202 });

  const supabase = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("register_reader", {
    target_tenant_id: serverEnv.defaultTenantId,
    target_funnel_slug: input.funnelSlug,
    reader_email: input.email,
    reader_name: input.name,
    target_registration_path: input.registrationPath,
    generated_access_token: createUrlToken(),
    generated_unsubscribe_token: createUrlToken(),
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    return Response.json({ error: "現在登録を受け付けられません。" }, { status: 503 });
  }

  const enrollment = data[0] as Enrollment;
  if (enrollment.subject && enrollment.body) {
    try {
      if (enrollment.initial_delivery_id) {
        const { data: claimed, error: claimError } = await supabase.from("deliveries")
          .update({ processing_started_at: new Date().toISOString(), error_message: null })
          .eq("id", enrollment.initial_delivery_id).eq("status", "processing")
          .select("id").maybeSingle();
        if (claimError || !claimed) throw new Error("初回メールの送信準備に失敗しました。");
      }
      const sent = await sendInitialMail({
        to: enrollment.email, name: enrollment.name, subject: enrollment.subject,
        body: enrollment.body, accessToken: enrollment.access_token,
        unsubscribeToken: enrollment.unsubscribe_token, funnelSlug: enrollment.funnel_slug,
        deadlineAt: enrollment.deadline_at, productId: enrollment.product_id,
      });
      if (enrollment.initial_delivery_id) {
        const { error: updateError } = await supabase.from("deliveries")
          .update({ status: "sent", sent_at: new Date().toISOString(), resend_message_id: sent.id,
            processing_started_at: null, error_message: null })
          .eq("id", enrollment.initial_delivery_id).eq("status", "processing");
        if (updateError) {
          return Response.json({ ok: true, message: "登録しました。送信記録の確定が遅れています。" }, { status: 202 });
        }
        // アクション管理(4.2.2): 1通目は即時送信のため、ここで送信後ラベルを付与する。
        if (enrollment.initial_grant_label_id) {
          await supabase.from("reader_labels").upsert(
            { tenant_id: serverEnv.defaultTenantId, reader_id: enrollment.reader_id, label_id: enrollment.initial_grant_label_id },
            { onConflict: "reader_id,label_id", ignoreDuplicates: true },
          );
        }
      }
    } catch (error) {
      if (enrollment.initial_delivery_id) {
        const message = error instanceof Error ? error.message : "初回メールの送信に失敗しました。";
        await supabase.from("deliveries")
          .update({ status: "queued", processing_started_at: null, error_message: message.slice(0, 1000) })
          .eq("id", enrollment.initial_delivery_id).eq("status", "processing");
      }
      return Response.json({ ok: true, message: "登録しました。メール配信が遅れています。" }, { status: 202 });
    }
  }
  return Response.json({ ok: true }, { status: 201 });
}
