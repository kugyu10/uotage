/**
 * ステップ配信（シナリオのステップメール）で使う置き換え文字・送信タイミングの共通ロジック。
 * サーバー専用の副作用（Resend送信）は含まないため、Server Component / Client Component の両方から
 * import できる。
 */

/**
 * 置き換え文字の定義。要件定義書 4.2.2「置き換え文字パネル」に対応する固定の6種類。
 */
export const STEP_PLACEHOLDER_VARIABLES = [
  { token: "{{name}}", label: "お名前" },
  { token: "{{offer_url}}", label: "オファーURL" },
  { token: "{{booking_url}}", label: "予約URL" },
  { token: "{{deadline}}", label: "締切日時" },
  { token: "{{unsubscribe_url}}", label: "配信停止URL" },
  { token: "{{member_url}}", label: "会員サイトURL" },
] as const;

/** プレビュー・テスト送信で置き換え文字を解決するためのサンプル値。 */
export const STEP_PREVIEW_SAMPLE_VALUES: Record<string, string> = {
  "{{name}}": "山田様",
  "{{offer_url}}": "https://example.com/offer/sample?token=sample-token",
  "{{booking_url}}": "https://example.com/booking/sample",
  "{{deadline}}": "2026-08-22 21:00",
  "{{unsubscribe_url}}": "https://example.com/unsubscribe?u=sample-token",
  "{{member_url}}": "https://example.com/member",
};

/** 送信タイミングのUI選択値。UTAGE表記「シナリオ登録直後」/「N日後 HH:00」の2択。 */
export type StepTimingMode = "immediate" | "days_after";

export function timingModeFromStep(step: { delay_minutes: number; send_at_hour: number | null }): StepTimingMode {
  return step.delay_minutes === 0 && step.send_at_hour === null ? "immediate" : "days_after";
}

/** UTAGE表記「N日後 HH:00」→ DB の delay_minutes / send_at_hour への変換。分は00固定。 */
export function toStepTiming(
  mode: StepTimingMode,
  daysAfter: number,
  hour: number,
): { delayMinutes: number; sendAtHour: number | null } {
  if (mode === "immediate") return { delayMinutes: 0, sendAtHour: null };
  const days = Number.isFinite(daysAfter) && daysAfter > 0 ? Math.floor(daysAfter) : 1;
  const safeHour = Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : 9;
  return { delayMinutes: days * 1440, sendAtHour: safeHour };
}

/** 本文・件名の置き換え文字を values で解決する。 */
export function renderStepTemplate(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((rendered, [token, value]) => rendered.replaceAll(token, value), text);
}
