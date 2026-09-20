import { createHash } from "node:crypto";

/**
 * CSVインポートで「ドライランしたファイル」と「確定実行が取り込むファイル」が
 * 同一であることを担保するためのモジュール（issue #2）。
 *
 * 確定実行はアップロードされたファイルをサーバーで再パースする（検証済み行を
 * RSCペイロードでクライアントへ往復させない）。その代わり「ドライランで件数を確認した
 * ファイル」と「確定実行で取り込むファイル」が別物になりうるため、previewImport が
 * 返したハッシュを `.bind()` 経由で confirmImport に戻し、再パース前に照合する。
 * `.bind()` の引数は暗号化されるため、クライアントでハッシュを改竄してドライランを
 * 迂回することはできない。
 *
 * ハッシュ対象はデコード後の文字列ではなく**生のバイト列**。デコードすると不正な
 * UTF-8 バイト列が U+FFFD に潰れ、バイト列としては別物のファイルが同じハッシュに
 * なりうるため（レビュー指摘 🟢5）。
 *
 * 判定そのものを actions.ts から切り出しているのは、確定実行の本体（confirmImport）が
 * requireOperator / createAdminClient という差し替えの効かない依存を先に通るため、
 * ここだけを FormData を直接渡して単体テストできるようにするため。
 */

/** アップロードを受け付けるCSVの上限。行数上限（MAX_IMPORT_ROWS）とは別の防御。 */
export const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** 同一性の判定に使うハッシュ。生バイト列の SHA-256（hex 64桁）。 */
export function hashImportCsvBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * ドライランと確定実行が必ず同じ文字列を見るための、単一のデコード入口。
 * 片方だけ別のデコード経路を使うと、ハッシュが一致しているのにパース結果が
 * 食い違うという最も厄介な壊れ方をするため、ここに1本化する。
 * BOM は parseCsv 側が除去するのでここでは触らない。
 */
export function decodeImportCsv(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export type ConfirmedImportFile = { ok: true; text: string } | { ok: false; error: string };

/**
 * 確定実行で再アップロードされたCSVを検証し、パース対象のテキストを返す。
 *
 * 判定の順序に意味がある（ドライラン必須 → ファイルの有無 → サイズ → 内容の同一性）。
 * 特に同一性の照合はパースより前に置く。「表示された件数」と「実際に取り込む内容」が
 * ずれた状態を一瞬も作らないため。
 */
export async function readConfirmedImportFile(
  formData: FormData,
  expectedFileHash: string | undefined,
): Promise<ConfirmedImportFile> {
  // ドライラン必須。expectedFileHash は previewImport が成功したときにしか発行されない。
  if (!expectedFileHash) {
    return { ok: false, error: "先にドライランを実行してください。" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "CSVファイルを選択して、もう一度ドライランからやり直してください。" };
  }
  if (file.size > MAX_IMPORT_FILE_SIZE_BYTES) {
    return { ok: false, error: "ファイルサイズが大きすぎます（5MB以下にしてください）。" };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (hashImportCsvBytes(bytes) !== expectedFileHash) {
    return {
      ok: false,
      error: "ドライラン後にファイルが変更されています。もう一度ドライランからやり直してください。",
    };
  }

  return { ok: true, text: decodeImportCsv(bytes) };
}
