import { parseCsv } from "./parse";
import { KNOWN_CSV_HEADERS } from "./columns";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NormalizedImportRow {
  /** CSV内の行番号（1始まり、ヘッダー行を含む）。プレビュー表示用。 */
  line: number;
  email: string;
  name: string | null;
  registrationPath: string | null;
  labels: string[];
  customFields: Record<string, string>;
}

export interface InvalidImportRow {
  line: number;
  reason: string;
}

export interface ParsedImportCsv {
  rows: NormalizedImportRow[];
  invalidRows: InvalidImportRow[];
  /** 行内で参照されているラベル名（重複なし、出現順）。 */
  labels: string[];
}

/**
 * UTAGE互換の読者CSV（要件定義書 10.2）をパースし、正規化された行と不正行を返す。
 * DBアクセスは行わない純粋関数（ドライラン・確定実行の両方から利用する）。
 */
export function parseImportCsv(text: string): ParsedImportCsv {
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new Error("EMPTY_CSV");
  }

  const header = table[0];
  const emailIndex = header.indexOf("メールアドレス");
  if (emailIndex === -1) {
    throw new Error("MISSING_EMAIL_HEADER");
  }
  const nameIndex = header.indexOf("名前");
  const pathIndex = header.indexOf("登録経路");
  const labelIndex = header.indexOf("ラベル");
  // 未知のカラム（10.1/10.2で定義済みの固定カラム以外）は custom_fields に格納する。
  const customColumns = header
    .map((columnName, index) => ({ columnName, index }))
    .filter(({ columnName, index }) => index !== emailIndex && columnName.trim().length > 0 && !KNOWN_CSV_HEADERS.has(columnName));

  const rows: NormalizedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];
  const seenEmails = new Set<string>();
  const seenLabels = new Set<string>();
  const labels: string[] = [];

  for (let rowIndex = 1; rowIndex < table.length; rowIndex += 1) {
    const line = rowIndex + 1;
    const raw = table[rowIndex];
    const email = (raw[emailIndex] ?? "").trim().toLowerCase();

    if (!email) {
      invalidRows.push({ line, reason: "メールアドレスが空です" });
      continue;
    }
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      invalidRows.push({ line, reason: `メールアドレスの形式が不正です: ${email}` });
      continue;
    }
    if (seenEmails.has(email)) {
      invalidRows.push({ line, reason: `ファイル内で重複しています: ${email}` });
      continue;
    }
    seenEmails.add(email);

    const name = nameIndex >= 0 ? (raw[nameIndex] ?? "").trim() || null : null;
    const registrationPath = pathIndex >= 0 ? (raw[pathIndex] ?? "").trim() || null : null;
    const rowLabels =
      labelIndex >= 0
        ? (raw[labelIndex] ?? "")
            .split(",")
            .map((label) => label.trim())
            .filter((label) => label.length > 0)
        : [];
    for (const label of rowLabels) {
      if (!seenLabels.has(label)) {
        seenLabels.add(label);
        labels.push(label);
      }
    }

    const customFields: Record<string, string> = {};
    for (const { columnName, index } of customColumns) {
      const value = (raw[index] ?? "").trim();
      if (value.length > 0) customFields[columnName] = value;
    }

    rows.push({ line, email, name, registrationPath, labels: rowLabels, customFields });
  }

  return { rows, invalidRows, labels };
}
