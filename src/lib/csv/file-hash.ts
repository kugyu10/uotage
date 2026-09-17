import { createHash } from "node:crypto";

/**
 * CSVインポートのドライランと確定実行が「同じファイル」を見ていることを検証するためのハッシュ。
 *
 * 確定実行はアップロードされたファイルをサーバーで再パースする（issue #2。検証済み行を
 * RSCペイロードでクライアントへ往復させない）。その代わり「ドライランで件数を確認した
 * ファイル」と「確定実行で取り込むファイル」が別物になりうるため、previewImport が
 * 返したハッシュを `.bind()` 経由で confirmImport に戻し、再パース前に照合する。
 * `.bind()` の引数は暗号化されるため、クライアントでハッシュを改竄してドライランを
 * 迂回することはできない。
 */
export function hashImportCsvText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
