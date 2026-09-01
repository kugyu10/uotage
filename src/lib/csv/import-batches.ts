/**
 * 1回のインポートで受け付ける最大行数（有効行＋不正行）。
 *
 * 上限を設ける理由は2つある。
 *   1. ドライラン結果（validRows / invalidRows）は RSCペイロードでクライアントへ渡り、
 *      確定実行時に `.bind()` 経由でサーバーへ戻る。Server Action のリクエストボディは
 *      既定1MB（next.config.ts で引き上げ済み）で、行数無制限だと必ず溢れる。
 *   2. import_scenario_readers は行ごとに `select ... for update` とラベル解決を回すため、
 *      1回のトランザクションに数万行を渡すと statement timeout に当たる。
 * ファイルサイズ上限（5MB）だけでは短い行が数万行あるCSVを止められないので、行数でも縛る。
 */
export const MAX_IMPORT_ROWS = 5000;

/**
 * 確定実行でRPCに1回あたり渡す行数。
 * MAX_IMPORT_ROWS = 5000 なら最大10回の呼び出しに分かれる。
 * 大きすぎるとトランザクションが長くなり、小さすぎると往復回数が増える。
 */
export const IMPORT_BATCH_SIZE = 500;

/** プレビューで一覧表示する不正行の上限。超過分は件数だけ伝える（ペイロード肥大の抑制）。 */
export const MAX_INVALID_ROWS_SHOWN = 100;

/** import_scenario_readers が返すサマリ。バッチ間で合算する。 */
export interface ImportSummary {
  createdReaders: number;
  updatedReaders: number;
  newEnrollments: number;
  skippedEnrollments: number;
  deliveriesQueued: number;
}

export const EMPTY_IMPORT_SUMMARY: ImportSummary = {
  createdReaders: 0,
  updatedReaders: 0,
  newEnrollments: 0,
  skippedEnrollments: 0,
  deliveriesQueued: 0,
};

/**
 * 配列を先頭から順に size 件ずつに分割する。順序は保持する。
 * size が 1 未満の場合は分割せず全件を1バッチとして返す（呼び出し側の設定ミスで
 * 無限ループになるより、1回のRPCで失敗させたほうが原因が分かりやすい）。
 */
export function chunkRows<T>(rows: readonly T[], size: number = IMPORT_BATCH_SIZE): T[][] {
  if (rows.length === 0) return [];
  if (!Number.isFinite(size) || size < 1) return [rows.slice()];

  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    batches.push(rows.slice(start, start + size));
  }
  return batches;
}

/** バッチごとのサマリを足し合わせる（RPCは1バッチ=1トランザクションなので合算が総計になる）。 */
export function addImportSummary(base: ImportSummary, delta: ImportSummary): ImportSummary {
  return {
    createdReaders: base.createdReaders + delta.createdReaders,
    updatedReaders: base.updatedReaders + delta.updatedReaders,
    newEnrollments: base.newEnrollments + delta.newEnrollments,
    skippedEnrollments: base.skippedEnrollments + delta.skippedEnrollments,
    deliveriesQueued: base.deliveriesQueued + delta.deliveriesQueued,
  };
}

/** RPCが返す snake_case のサマリ1行を ImportSummary に正規化する（欠損は0扱い）。 */
export function toImportSummary(raw: unknown): ImportSummary {
  const row = (raw ?? {}) as Record<string, unknown>;
  const asCount = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    createdReaders: asCount(row.created_readers),
    updatedReaders: asCount(row.updated_readers),
    newEnrollments: asCount(row.new_enrollments),
    skippedEnrollments: asCount(row.skipped_enrollments),
    deliveriesQueued: asCount(row.deliveries_queued),
  };
}

/**
 * 行数上限を超えていないか判定する。超過時は表示用の日本語メッセージを返す。
 * 不正行もRSCペイロードに乗るため、有効行と不正行の合計で判定する。
 */
export function checkImportRowLimit(validRowCount: number, invalidRowCount: number): string | null {
  const total = validRowCount + invalidRowCount;
  if (total <= MAX_IMPORT_ROWS) return null;
  return (
    `CSVの行数が多すぎます（${total.toLocaleString("ja-JP")}行）。` +
    `1回のインポートは${MAX_IMPORT_ROWS.toLocaleString("ja-JP")}行までです。` +
    `ファイルを分割してから取り込んでください。`
  );
}
