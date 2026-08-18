import { buildCsv, sanitizeCsvCell, UTF8_BOM } from "./format";
import { CSV_HEADERS } from "./columns";
import { formatJstDateTime } from "./timezone";

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

  return UTF8_BOM + buildCsv(headers, csvRows);
}
