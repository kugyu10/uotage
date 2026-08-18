"use server";

import { revalidatePath } from "next/cache";

import { createUrlToken } from "@/lib/registration";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import { parseImportCsv, type InvalidImportRow, type NormalizedImportRow } from "@/lib/csv/import-rows";
import { jstDatetimeLocalToUtcIso } from "@/lib/csv/timezone";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export type DeliveryMode = "none" | "from_now" | "from_start";

export interface PreviewState {
  status: "idle" | "error" | "ready";
  error?: string;
  fileName?: string;
  totalRows?: number;
  newReaders?: number;
  existingReaders?: number;
  alreadyEnrolled?: number;
  newLabels?: string[];
  invalidRows?: InvalidImportRow[];
  validRows?: NormalizedImportRow[];
}

export const initialPreviewState: PreviewState = { status: "idle" };

/** ドライラン: 取り込み件数・新規/既存件数・自動作成ラベル・不正行を計算する（DB書き込みなし）。 */
export async function previewImport(
  scenarioId: string,
  _prevState: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  if (!isUuid(scenarioId)) {
    return { status: "error", error: "シナリオが見つかりません。" };
  }

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) {
    return { status: "error", error: "シナリオが見つかりません。" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", error: "CSVファイルを選択してください。" };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { status: "error", error: "ファイルサイズが大きすぎます（5MB以下にしてください）。" };
  }

  const text = await file.text();
  let parsed;
  try {
    parsed = parseImportCsv(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (message === "MISSING_EMAIL_HEADER") {
      return { status: "error", error: "ヘッダー行に「メールアドレス」列が見つかりません。" };
    }
    if (message === "EMPTY_CSV") {
      return { status: "error", error: "CSVファイルが空です。" };
    }
    return { status: "error", error: "CSVの読み込みに失敗しました。" };
  }

  if (parsed.rows.length === 0) {
    return {
      status: "error",
      error: "取り込み対象の行がありません。",
      invalidRows: parsed.invalidRows,
    };
  }

  const emails = parsed.rows.map((row) => row.email);
  const { data: existingReaders } = await supabase
    .from("readers")
    .select("id, email")
    .eq("tenant_id", operator.tenant_id)
    .in("email", emails);
  const existingReaderIdByEmail = new Map<string, string>((existingReaders ?? []).map((reader) => [reader.email, reader.id]));

  const { data: existingLabels } = await supabase.from("labels").select("name").eq("tenant_id", operator.tenant_id);
  const existingLabelNames = new Set((existingLabels ?? []).map((label) => label.name));
  const newLabels = parsed.labels.filter((label) => !existingLabelNames.has(label));

  let alreadyEnrolled = 0;
  const existingReaderIds = Array.from(existingReaderIdByEmail.values());
  if (existingReaderIds.length > 0) {
    const { data: enrollments } = await supabase
      .from("scenario_readers")
      .select("reader_id")
      .eq("tenant_id", operator.tenant_id)
      .eq("scenario_id", scenarioId)
      .in("reader_id", existingReaderIds);
    const enrolledReaderIds = new Set((enrollments ?? []).map((row) => row.reader_id));
    for (const row of parsed.rows) {
      const readerId = existingReaderIdByEmail.get(row.email);
      if (readerId && enrolledReaderIds.has(readerId)) alreadyEnrolled += 1;
    }
  }

  return {
    status: "ready",
    fileName: file.name,
    totalRows: parsed.rows.length,
    newReaders: parsed.rows.filter((row) => !existingReaderIdByEmail.has(row.email)).length,
    existingReaders: parsed.rows.filter((row) => existingReaderIdByEmail.has(row.email)).length,
    alreadyEnrolled,
    newLabels,
    invalidRows: parsed.invalidRows,
    validRows: parsed.rows,
  };
}

export interface ConfirmState {
  status: "idle" | "error" | "done";
  error?: string;
  createdReaders?: number;
  updatedReaders?: number;
  newEnrollments?: number;
  skippedEnrollments?: number;
  deliveriesQueued?: number;
}

export const initialConfirmState: ConfirmState = { status: "idle" };

/** 確定実行: ドライランで検証済みの行だけを受け取り、SECURITY DEFINER RPCへ委譲する。 */
export async function confirmImport(
  scenarioId: string,
  validRows: NormalizedImportRow[],
  _prevState: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  if (!isUuid(scenarioId)) {
    return { status: "error", error: "シナリオが見つかりません。" };
  }

  const { supabase, operator } = await requireOperator();

  const { data: scenario } = await supabase
    .from("scenarios")
    .select("id")
    .eq("tenant_id", operator.tenant_id)
    .eq("id", scenarioId)
    .maybeSingle();
  if (!scenario) {
    return { status: "error", error: "シナリオが見つかりません。" };
  }

  if (!validRows || validRows.length === 0) {
    return { status: "error", error: "取り込み対象の行がありません。もう一度ドライランを実行してください。" };
  }

  const deliveryModeRaw = formData.get("deliveryMode");
  const deliveryMode: DeliveryMode =
    deliveryModeRaw === "from_now" || deliveryModeRaw === "from_start" ? deliveryModeRaw : "none";

  let targetRegisteredAt: string | null = null;
  if (deliveryMode === "from_now") {
    const registeredAtRaw = formData.get("registeredAt");
    if (typeof registeredAtRaw !== "string" || registeredAtRaw.length === 0) {
      return { status: "error", error: "配信を開始する日時を指定してください。" };
    }
    try {
      targetRegisteredAt = jstDatetimeLocalToUtcIso(registeredAtRaw);
    } catch {
      return { status: "error", error: "日時の形式が不正です。" };
    }
  }

  const rowsPayload = validRows.map((row) => ({
    email: row.email,
    name: row.name,
    registration_path: row.registrationPath,
    labels: row.labels,
    custom_fields: row.customFields,
    access_token: createUrlToken(),
    unsubscribe_token: createUrlToken(),
    unsubscribed: row.unsubscribed,
  }));

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("import_scenario_readers", {
    target_tenant_id: operator.tenant_id,
    target_scenario_id: scenarioId,
    delivery_mode: deliveryMode,
    target_registered_at: targetRegisteredAt,
    rows: rowsPayload,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { status: "error", error: "インポートの実行に失敗しました。時間を置いて再度お試しください。" };
  }

  const summary = data[0] as {
    created_readers: number;
    updated_readers: number;
    new_enrollments: number;
    skipped_enrollments: number;
    deliveries_queued: number;
  };

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/import`);

  return {
    status: "done",
    createdReaders: summary.created_readers,
    updatedReaders: summary.updated_readers,
    newEnrollments: summary.new_enrollments,
    skippedEnrollments: summary.skipped_enrollments,
    deliveriesQueued: summary.deliveries_queued,
  };
}
