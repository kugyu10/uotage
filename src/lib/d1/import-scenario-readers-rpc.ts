/**
 * issue #29 [移行 P5]: `workers/tenant-do/src/index.ts` の
 * `TenantDurableObject.importScenarioReaders` RPC の中身を、Cloudflare Workers 型に
 * 依存しない形で切り出したもの。register-reader-rpc.ts / process-stripe-purchase-rpc.ts
 * と同じ理由・同じ構造（そちらのヘッダコメント参照）。
 */
import { createTenantDb, type D1Executor } from "./tenant-db.ts";
import { resolveTenantIdFromDoName } from "./resolve-tenant-id.ts";
import {
  importScenarioReaders,
  type ImportScenarioReadersInput,
  type ImportScenarioReadersResult,
} from "../readers/import-scenario-readers.ts";

export interface ImportScenarioReadersRpcResult {
  ok: boolean;
  /** 成功時のみ。 */
  result?: ImportScenarioReadersResult;
  /** 失敗時のみ。Error#message。 */
  error?: string;
  /** 失敗時のみ。Error#name（呼び出し側が TooManyImportRowsError 等を判別するのに使う）。 */
  errorName?: string;
}

/**
 * `importScenarioReaders` を「DOインスタンス名からテナントIDを解決 → テナント境界つき DB を
 * 組み立てる → 実行する」まで含めて行う。例外は投げず `{ ok, result | error, errorName }` を
 * 返す（呼び出し側の DOクラスが try/catch を書かずに済むようにするため。
 * register-reader-rpc.ts の runRegisterReaderRpc と同じ構造）。
 *
 * `doName` は `this.ctx.id.name`（`idFromName(tenantId)` で作った ID の name）を
 * そのまま渡すこと。
 *
 * `input` はアプリ側のバッチ分割（IMPORT_BATCH_SIZE 件ずつ）1回分に対応する。
 * `input.executedAt` は全バッチで同一の値を渡すこと（import-scenario-readers.ts
 * のヘッダコメント参照）。
 */
export async function runImportScenarioReadersRpc(
  executor: D1Executor,
  doName: string | null | undefined,
  input: ImportScenarioReadersInput,
): Promise<ImportScenarioReadersRpcResult> {
  try {
    const tenantId = resolveTenantIdFromDoName(doName);
    const db = createTenantDb(executor, tenantId);
    const result = await importScenarioReaders(db, input);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}
