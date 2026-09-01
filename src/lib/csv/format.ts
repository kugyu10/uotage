/** CSV出力用のフォーマッタ。BOM付与・引用符エスケープ・CSVインジェクション対策を提供する。 */

/** セルの値がカンマ・引用符・改行を含む場合はダブルクォートで囲み、内部の `"` を `""` にエスケープする。 */
export function formatCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatCsvRow(fields: string[]): string {
  return fields.map(formatCsvField).join(",");
}

/**
 * Excel/表計算ソフトが `=`, `+`, `-`, `@` で始まるセルを数式として実行してしまう
 * CSVインジェクションを防ぐため、該当する場合は先頭にシングルクォートを1つ付与する。
 * タブ・CR も Excel が数式の先頭として解釈しうるため対象に含める（OWASP 準拠）。
 *
 * データ行だけでなくヘッダー行にも適用すること。カスタム項目の列名は
 * インポートCSVのヘッダー由来、すなわち外部入力である。
 */
const FORMULA_PREFIX_PATTERN = /^[=+\-@\t\r]/;
export function sanitizeCsvCell(value: string): string {
  return FORMULA_PREFIX_PATTERN.test(value) ? `'${value}` : value;
}

/** ヘッダー行とデータ行から CRLF 区切りの CSV 本文を組み立てる（末尾にも CRLF を付与）。 */
export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [formatCsvRow(headers), ...rows.map(formatCsvRow)];
  return `${lines.join("\r\n")}\r\n`;
}

/** Excel での文字化けを防ぐための UTF-8 BOM。 */
export const UTF8_BOM = String.fromCharCode(0xfeff);
