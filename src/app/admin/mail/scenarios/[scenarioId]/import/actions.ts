"use server";

import { revalidatePath } from "next/cache";

import { createUrlToken } from "@/lib/registration";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOperator } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import { parseImportCsv, type InvalidImportRow, type NormalizedImportRow } from "@/lib/csv/import-rows";
import {
  addImportSummary,
  checkImportRowLimit,
  chunkRows,
  EMPTY_IMPORT_SUMMARY,
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_ROWS,
  MAX_INVALID_ROWS_SHOWN,
  toImportSummary,
  type ImportSummary,
} from "@/lib/csv/import-batches";
import { jstDatetimeLocalToUtcIso } from "@/lib/csv/timezone";
import { fetchAllPages, fetchInChunks } from "@/lib/supabase/paginate";

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
  /** 表示用に MAX_INVALID_ROWS_SHOWN 件で切った不正行。 */
  invalidRows?: InvalidImportRow[];
  /** 不正行の総数（invalidRows は切られている可能性があるため別に持つ）。 */
  invalidRowsTotal?: number;
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

  // 行数上限はファイルサイズ上限とは別に必要。短い行が数万行あるCSVは5MBに収まるが、
  // ドライラン結果のRSCペイロードとRPCのトランザクション時間の両方を破壊する。
  const rowLimitError = checkImportRowLimit(parsed.rows.length, parsed.invalidRows.length);
  if (rowLimitError) {
    return { status: "error", error: rowLimitError };
  }

  if (parsed.rows.length === 0) {
    return {
      status: "error",
      error: "取り込み対象の行がありません。",
      invalidRows: parsed.invalidRows.slice(0, MAX_INVALID_ROWS_SHOWN),
      invalidRowsTotal: parsed.invalidRows.length,
    };
  }

  // ここから3クエリ。いずれも `.in()` に最大5,000件を渡しうるので、
  // fetchInChunks でチャンクに分けてURI長を有界にする（全件渡すと約160〜195KBになり414）。
  //
  // エラーは必ず throw して status:"error" に落とす。以前は `data ?? []` で受けていたため、
  // 414 などで data が null になると「既存読者0人・全員新規」という集計になり、
  // ドライランの唯一の目的（取り込み前に件数を確かめる）が黙って嘘をついていた。
  let existingReaderIdByEmail: Map<string, string>;
  let existingLabelNames: Set<string>;
  let enrolledReaderIds: Set<string>;

  try {
    const existingReaders = await fetchInChunks<string, { id: string; email: string }>(
      parsed.rows.map((row) => row.email),
      (chunk, from, to) =>
        supabase
          .from("readers")
          .select("id, email")
          .eq("tenant_id", operator.tenant_id)
          .in("email", chunk)
          .order("id")
          .range(from, to),
    );
    existingReaderIdByEmail = new Map(existingReaders.map((reader) => [reader.email, reader.id]));

    // labels はテナント単位で件数が小さいはずだが、打ち切られると既存ラベルが
    // 「自動作成される新規ラベル」として表示されるためページングする
    // （エクスポート側の labels 取得と同じ判断）。
    // order は fetchAllPages の契約どおり一意なキー（id）で行う。
    const existingLabels = await fetchAllPages<{ id: string; name: string }>((from, to) =>
      supabase.from("labels").select("id, name").eq("tenant_id", operator.tenant_id).order("id").range(from, to),
    );
    existingLabelNames = new Set(existingLabels.map((label) => label.name));

    const enrollments = await fetchInChunks<string, { reader_id: string }>(
      Array.from(existingReaderIdByEmail.values()),
      (chunk, from, to) =>
        supabase
          .from("scenario_readers")
          .select("reader_id")
          .eq("tenant_id", operator.tenant_id)
          .eq("scenario_id", scenarioId)
          .in("reader_id", chunk)
          .order("reader_id")
          .range(from, to),
    );
    enrolledReaderIds = new Set(enrollments.map((row) => row.reader_id));
  } catch (error) {
    // 失敗の理由は複数ありうる（URI長超過による414・statement timeout・権限・ネットワーク断）。
    // オペレーターへの文言は出し分けないが、原因を追えるようにログには必ず残す。
    // 「時間を置いて再試行」が有効でないケース（権限など）もあるため文言は中立にする。
    console.error("[csv-import] 既存読者の照合に失敗", {
      scenarioId,
      tenantId: operator.tenant_id,
      rowCount: parsed.rows.length,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "error",
      error: "既存読者の照合に失敗しました。件数を確認できないため中断しました。管理者に連絡してください。",
    };
  }

  const newLabels = parsed.labels.filter((label) => !existingLabelNames.has(label));

  let alreadyEnrolled = 0;
  for (const row of parsed.rows) {
    const readerId = existingReaderIdByEmail.get(row.email);
    if (readerId && enrolledReaderIds.has(readerId)) alreadyEnrolled += 1;
  }

  return {
    status: "ready",
    fileName: file.name,
    totalRows: parsed.rows.length,
    newReaders: parsed.rows.filter((row) => !existingReaderIdByEmail.has(row.email)).length,
    existingReaders: parsed.rows.filter((row) => existingReaderIdByEmail.has(row.email)).length,
    alreadyEnrolled,
    newLabels,
    invalidRows: parsed.invalidRows.slice(0, MAX_INVALID_ROWS_SHOWN),
    invalidRowsTotal: parsed.invalidRows.length,
    validRows: parsed.rows,
  };
}

export interface ConfirmState {
  status: "idle" | "error" | "done" | "partial";
  error?: string;
  createdReaders?: number;
  updatedReaders?: number;
  newEnrollments?: number;
  skippedEnrollments?: number;
  deliveriesQueued?: number;
  /** バッチ途中で失敗した場合、反映が完了した行数（先頭から連続）。 */
  processedRows?: number;
  /** 取り込もうとした総行数。processedRows と対で「どこまで進んだか」を示す。 */
  totalRows?: number;
}

export const initialConfirmState: ConfirmState = { status: "idle" };

/**
 * 確定実行: ドライランで検証済みの行だけを受け取り、SECURITY DEFINER RPCへ委譲する。
 *
 * RPCは行ごとに `select ... for update` とラベル解決を回すため、全行を1トランザクションに
 * 渡すと statement timeout に当たる。IMPORT_BATCH_SIZE 件ずつに分けて複数回呼び出し、
 * サマリを合算する。
 *
 * バッチ途中で失敗したときの挙動（意図的な仕様）:
 *   - 1バッチ = 1トランザクション。成功済みのバッチはコミット済みで、ロールバックしない。
 *     全体を1トランザクションにすると timeout 問題が元に戻るため、部分適用を受け入れる。
 *   - 失敗時は status="partial" で、そこまでのサマリと processedRows / totalRows を返す。
 *     UIは「先頭から◯行までは反映済み」と明示し、同じCSVでの再実行を案内する。
 *   - 再実行は安全。readers は upsert、scenario_readers / reader_labels / deliveries は
 *     すべて ON CONFLICT DO NOTHING で、既に登録済みの読者はスキップ（期限もリセットしない）。
 *   - 実行時刻（target_executed_at）は全バッチで同一の値を渡す。RPC内の now() を
 *     バッチごとに取ると、登録日時・期限だけでなく「送信予定が過ぎたステップを積むか」の
 *     判定までバッチごとに動くため、ここで1つ決めて時間軸を固定する。
 */
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
  // ドライラン側でも弾いているが、古いプレビュー結果が残っている可能性があるため確定実行でも見る。
  if (validRows.length > MAX_IMPORT_ROWS) {
    return { status: "error", error: checkImportRowLimit(validRows.length, 0) ?? "行数が多すぎます。" };
  }

  const deliveryModeRaw = formData.get("deliveryMode");
  const deliveryMode: DeliveryMode =
    deliveryModeRaw === "from_now" || deliveryModeRaw === "from_start" ? deliveryModeRaw : "none";

  // 「この確定実行の時刻」を1つ決めて全バッチへ渡す。バッチごとにRPC内の now() を
  // 使うと、登録日時・期限（deadline_at）だけでなく「送信予定が過ぎたステップを積むか」の
  // 判定までバッチごとに動き、境界付近のステップが読者によって積まれたり積まれなかったり
  // する。時間軸を1本にするための値。
  const executedAt = new Date().toISOString();

  // registered_at は 'from_now' でオペレーターが指定した日時のみ。
  // それ以外は RPC 側が executedAt を登録日時として使う。
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
  const batches = chunkRows(rowsPayload, IMPORT_BATCH_SIZE);

  let summary: ImportSummary = EMPTY_IMPORT_SUMMARY;
  let processedRows = 0;

  for (const batch of batches) {
    const { data, error } = await admin.rpc("import_scenario_readers", {
      target_tenant_id: operator.tenant_id,
      target_scenario_id: scenarioId,
      delivery_mode: deliveryMode,
      target_registered_at: targetRegisteredAt,
      target_executed_at: executedAt,
      rows: batch,
    });

    if (error || !Array.isArray(data) || data.length === 0) {
      revalidatePath(`/admin/mail/scenarios/${scenarioId}/import`);
      if (processedRows === 0) {
        return { status: "error", error: "インポートの実行に失敗しました。時間を置いて再度お試しください。" };
      }
      // 先頭のバッチはコミット済み。何行まで反映されたかを必ず伝える。
      return {
        status: "partial",
        error: "インポートの途中でエラーが発生しました。",
        processedRows,
        totalRows: rowsPayload.length,
        ...summaryToState(summary),
      };
    }

    summary = addImportSummary(summary, toImportSummary(data[0]));
    processedRows += batch.length;
  }

  revalidatePath(`/admin/mail/scenarios/${scenarioId}/import`);

  return {
    status: "done",
    processedRows,
    totalRows: rowsPayload.length,
    ...summaryToState(summary),
  };
}

function summaryToState(summary: ImportSummary) {
  return {
    createdReaders: summary.createdReaders,
    updatedReaders: summary.updatedReaders,
    newEnrollments: summary.newEnrollments,
    skippedEnrollments: summary.skippedEnrollments,
    deliveriesQueued: summary.deliveriesQueued,
  };
}
