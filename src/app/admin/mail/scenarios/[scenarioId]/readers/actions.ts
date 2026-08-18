"use server";

import { revalidatePath } from "next/cache";

import { createUrlToken, parseRegistrationInput } from "@/lib/registration";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";

export type AddReaderState = {
  status: "idle" | "error" | "success";
  message: string;
};

const MANUAL_REGISTRATION_PATH = "manual";

/**
 * 読者一覧の「個別追加」フォーム用 Server Action。
 *
 * register_reader RPC（service role 専用）でシナリオ登録とステップ配信のキュー投入まで行う。
 * 1通目の即時送信はここでは行わない。キューに積まれた分は通常の配信バッチ（cron）が拾う。
 */
export async function addReader(
  _previous: AddReaderState,
  formData: FormData,
): Promise<AddReaderState> {
  const { supabase, operator } = await requireOperator();

  const scenarioId = String(formData.get("scenarioId") ?? "");
  if (!isUuid(scenarioId)) {
    return { status: "error", message: "シナリオが指定されていません。" };
  }

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id, funnel_id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) {
    return { status: "error", message: "シナリオが見つかりません。" };
  }
  if (!scenario.funnel_id) {
    return {
      status: "error",
      message:
        "このシナリオにはファネルが設定されていないため、個別追加できません。ファネル設定でシナリオを紐づけてください。",
    };
  }

  const { data: funnel } = await supabase
    .from("funnels")
    .select("id, slug, trigger_type, is_active")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenario.funnel_id)
    .maybeSingle();
  if (!funnel || !funnel.is_active || funnel.trigger_type !== "registration") {
    return {
      status: "error",
      message: "このシナリオに紐づく有効な登録ファネルが見つからないため、個別追加できません。",
    };
  }

  // register_reader はファネルの slug から「最初に作成された有効なシナリオ」を解決するため、
  // 同じファネルに複数の有効なシナリオがぶら下がっている場合は誤ったシナリオへ登録してしまう
  // おそれがある。事故防止のため、解決先がこのシナリオと一致することを事前に確認する。
  const { data: resolvedScenario } = await supabase
    .from("scenarios")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("funnel_id", funnel.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!resolvedScenario || resolvedScenario.id !== scenarioId) {
    return {
      status: "error",
      message:
        "このファネルは別のシナリオが登録対象になっているため、このシナリオへは個別追加できません。",
    };
  }

  let input;
  try {
    input = parseRegistrationInput({
      email: formData.get("email"),
      name: formData.get("name"),
      funnelSlug: funnel.slug,
      registrationPath: null,
      website: "",
    });
  } catch {
    return { status: "error", message: "メールアドレスを正しく入力してください。" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("register_reader", {
    target_tenant_id: operator.tenant_id,
    target_funnel_slug: input.funnelSlug,
    reader_email: input.email,
    reader_name: input.name,
    // registration_paths に事前登録された経路のみ受け付ける仕様のため null で呼び、
    // 「manual」という登録経路は下の更新で直接記録する。
    target_registration_path: null,
    generated_access_token: createUrlToken(),
    generated_unsubscribe_token: createUrlToken(),
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    return { status: "error", message: "登録に失敗しました。時間をおいて再度お試しください。" };
  }
  const enrollment = data[0] as { email: string };

  const { data: reader } = await supabase
    .from("readers")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("email", enrollment.email)
    .maybeSingle();
  if (reader) {
    // 既存の登録経路（フォーム経由など）は上書きしない。新規登録のときだけ manual を記録する。
    await supabase
      .from("scenario_readers")
      .update({ registration_path: MANUAL_REGISTRATION_PATH })
      .eq("tenant_id", operator.tenant_id)
      .eq("scenario_id", scenarioId)
      .eq("reader_id", reader.id)
      .is("registration_path", null);
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/readers`);
  return {
    status: "success",
    message: `${input.email} を登録しました。初回メールも配信キューに登録済みです。即時送信はしないため、通常の配信バッチで送信されます。`,
  };
}
