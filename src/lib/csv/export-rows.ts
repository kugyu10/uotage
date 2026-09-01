// このディレクトリの相対importは拡張子(.ts)を明記している。
// リポジトリの他の場所は拡張子なしだが、ここだけは
// `node --test --experimental-strip-types` からテストが直接importするため。
// 型ストリッピングはバンドラのような拡張子補完を行わず、拡張子なしでは
// ERR_MODULE_NOT_FOUND になる（tsconfig の allowImportingTsExtensions で型検査は通る）。
// 規約をリポジトリ全体へ広げるかは未決（issue #4）。
import { buildCsv, sanitizeCsvCell, UTF8_BOM } from "./format.ts";
import { CSV_HEADERS } from "./columns.ts";
import { formatJstDateTime } from "./timezone.ts";

export interface ExportReaderRow {
  email: string;
  name: string | null;
  registeredAt: string;
  registrationPath: string | null;
  labels: string[];
  purchasedProducts: string[];
  unsubscribed: boolean;
  customFields: Record<string, unknown>;
}

function stringifyCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * シナリオ単位の読者一覧を UTAGE互換CSV（要件定義書 10.1）に変換する。
 * UTF-8 BOM付き、日本語ヘッダー、CSVインジェクション対策込みの純粋関数。
 */
export function buildScenarioExportCsv(rows: ExportReaderRow[]): string {
  const customFieldKeys = Array.from(new Set(rows.flatMap((row) => Object.keys(row.customFields)))).sort();
  const headers = [...CSV_HEADERS, ...customFieldKeys];

  const csvRows = rows.map((row) => {
    const cells = [
      row.email,
      row.name ?? "",
      formatJstDateTime(row.registeredAt),
      row.registrationPath ?? "",
      row.labels.join(","),
      row.purchasedProducts.join(","),
      row.unsubscribed ? "解除済み" : "",
      ...customFieldKeys.map((key) => stringifyCustomFieldValue(row.customFields[key])),
    ];
    return cells.map(sanitizeCsvCell);
  });

  // customFieldKeys はインポートCSVのヘッダー由来（外部入力）なので、
  // ヘッダー行にも数式プレフィクス対策を掛ける。
  return UTF8_BOM + buildCsv(headers.map(sanitizeCsvCell), csvRows);
}
