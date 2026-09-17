"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { Resend } from "resend";

import { renderStepTemplate, STEP_PREVIEW_SAMPLE_VALUES, toStepTiming, type StepTimingMode } from "@/lib/mail-steps";
import { serverEnv } from "@/lib/env";
import { requireOperator } from "@/lib/supabase/server";

/** ステップの内容（送信タイミング・件名・本文・アクション）を保存する。 */
export async function updateStep(scenarioId: string, stepId: string, formData: FormData) {
  const { supabase, operator } = await requireOperator();

  const mode = (formData.get("timing_mode") === "days_after" ? "days_after" : "immediate") as StepTimingMode;
  const daysAfter = Number(formData.get("days_after") ?? 1);
  const sendHour = Number(formData.get("send_hour") ?? 9);
  const { delayMinutes, sendAtHour } = toStepTiming(mode, daysAfter, sendHour);

  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const skipIfPurchased = formData.get("skip_if_purchased") === "on";
  const grantLabelIdRaw = String(formData.get("grant_label_id") ?? "").trim();

  if (!subject) {
    throw new Error("件名は必須です。");
  }

  const { error } = await supabase
    .from("step_messages")
    .update({
      delay_minutes: delayMinutes,
      send_at_hour: sendAtHour,
      subject,
      body,
      skip_if_purchased: skipIfPurchased,
      grant_label_id: grantLabelIdRaw || null,
    })
    .eq("tenant_id", operator.tenant_id)
    .eq("scenario_id", scenarioId)
    .eq("id", stepId);

  if (error) {
    throw new Error("ステップの保存に失敗しました。");
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps`);
  revalidatePath(`/admin/mail/scenarios/${scenarioId}/steps/${stepId}`);
}

/**
 * 自分（ログイン中のオペレーター）宛のテスト送信。編集中の件名・本文（未保存でも可）を
 * サンプル値で置き換え文字を解決し、件名に「[テスト] 」を付けて1件だけ送信する。
 *
 * 注意: 夜間作業ガードにより実メール送信は禁止されているため、この関数は実装のみで
 * 夜間作業中に実行・実送信はしない。
 */
export async function sendTestStep(scenarioId: string, subject: string, body: string) {
  const { supabase, operator } = await requireOperator();

  const { data: auth } = await supabase.auth.getUser();
  const to = auth.user?.email;
  if (!to) {
    throw new Error("ログイン中のメールアドレスを取得できませんでした。");
  }

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("delivery_account_id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) throw new Error("シナリオが見つかりません。");

  const { data: account } = await supabase
    .from("delivery_accounts")
    .select("from_name, from_email")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenario.delivery_account_id)
    .maybeSingle();
  if (!account) throw new Error("配信アカウントが見つかりません。");

  const renderedSubject = `[テスト] ${renderStepTemplate(subject, STEP_PREVIEW_SAMPLE_VALUES)}`;
  const renderedBody = renderStepTemplate(body, STEP_PREVIEW_SAMPLE_VALUES);

  const resend = new Resend(serverEnv.resendApiKey);
  const result = await resend.emails.send({
    from: `${account.from_name} <${account.from_email}>`,
    to: [to],
    subject: renderedSubject,
    html: `<div style="white-space:pre-wrap">${escapeHtml(renderedBody)}</div>`,
    text: renderedBody,
  });

  if (result.error || !result.data?.id) {
    throw new Error("テスト送信に失敗しました。");
  }
  return { id: result.data.id };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}
