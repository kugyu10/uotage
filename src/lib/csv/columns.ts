/**
 * UTAGE互換の読者CSVで使う固定カラム定義（要件定義書 10.1 / 10.2）。
 * エクスポート・インポートの両方でヘッダー名を共有する。
 */
export const CSV_HEADERS = [
  "メールアドレス",
  "名前",
  "登録日時",
  "登録経路",
  "ラベル",
  "購入状況",
  "解除状況",
] as const;

export type CsvHeader = (typeof CSV_HEADERS)[number];

export const KNOWN_CSV_HEADERS: ReadonlySet<string> = new Set(CSV_HEADERS);
