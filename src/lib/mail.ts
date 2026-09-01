import "server-only";

import { Resend } from "resend";

import { publicEnv, serverEnv } from "@/lib/env";

type InitialMail = {
  to: string;
  name: string | null;
  subject: string;
  body: string;
  accessToken: string;
  unsubscribeToken: string;
  funnelSlug: string;
  deadlineAt: string;
  productId: string | null;
};

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

/** Phase 1 の初回メールで使う最小限の置き換え文字を解決する。 */
export async function sendInitialMail(mail: InitialMail) {
  const appUrl = publicEnv.appUrl.replace(/\/$/, "");
  const offerUrl = `${appUrl}/offer/${encodeURIComponent(mail.funnelSlug)}?token=${encodeURIComponent(mail.accessToken)}`;
  const unsubscribeUrl = `${appUrl}/unsubscribe?u=${encodeURIComponent(mail.unsubscribeToken)}`;
  const oneClickUnsubscribeUrl = `${appUrl}/api/unsubscribe?u=${encodeURIComponent(mail.unsubscribeToken)}`;
  const memberUrl = mail.productId ? `${appUrl}/course/${mail.productId}?token=${encodeURIComponent(mail.accessToken)}` : appUrl;
  const deadline = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(mail.deadlineAt));
  const variables: Record<string, string> = {
    "{{name}}": mail.name ?? "",
    "{{offer_url}}": offerUrl,
    "{{booking_url}}": offerUrl,
    "{{deadline}}": deadline,
    "{{unsubscribe_url}}": unsubscribeUrl,
    "{{member_url}}": memberUrl,
  };
  const rendered = Object.entries(variables).reduce(
    (body, [variable, value]) => body.replaceAll(variable, value),
    mail.body,
  );

  const resend = new Resend(serverEnv.resendApiKey);
  const result = await resend.emails.send({
    from: serverEnv.resendFrom,
    to: [mail.to],
    subject: mail.subject,
    html: `<div style="white-space:pre-wrap">${escapeHtml(rendered)}</div>`,
    text: rendered,
    headers: {
      "List-Unsubscribe": `<${oneClickUnsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (result.error || !result.data?.id) {
    throw new Error("初回メールの送信に失敗しました。");
  }
  return result.data;
}
