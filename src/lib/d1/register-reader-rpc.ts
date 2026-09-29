/**
 * issue #29 [移行 P5]: `workers/tenant-do/src/index.ts` の `TenantDurableObject.registerReader`
 * RPC の中身を、Cloudflare Workers 型に依存しない形で切り出したもの。
 * process-stripe-purchase-rpc.ts と同じ理由・同じ構造（そちらのヘッダコメント参照）。
 */
import { createTenantDb, type D1Executor } from "./tenant-db.ts";
import { resolveTenantIdFromDoName } from "./resolve-tenant-id.ts";
import { registerReader, type RegisterReaderInput, type RegisterReaderResult } from "../readers/register-reader.ts";

export interface RegisterReaderRpcResult {
  ok: boolean;
  /** 成功時のみ。 */
  result?: RegisterReaderResult;
  /** 失敗時のみ。Error#message。 */
  error?: string;
  /** 失敗時のみ。Error#name（呼び出し側が ActiveRegistrationFunnelNotFoundError 等を判別するのに使う）。 */
  errorName?: string;
}

/**
 * `registerReader` を「DOインスタンス名からテナントIDを解決 → テナント境界つき DB を
 * 組み立てる → 実行する」まで含めて行う。例外は投げず `{ ok, result | error, errorName }` を
 * 返す（呼び出し側の DOクラスが try/catch を書かずに済むようにするため。
 * process-stripe-purchase-rpc.ts の runProcessStripePurchaseRpc と同じ構造）。
 *
 * `doName` は `this.ctx.id.name`（`idFromName(tenantId)` で作った ID の name）を
 * そのまま渡すこと。
 */
export async function runRegisterReaderRpc(
  executor: D1Executor,
  doName: string | null | undefined,
  input: RegisterReaderInput,
): Promise<RegisterReaderRpcResult> {
  try {
    const tenantId = resolveTenantIdFromDoName(doName);
    const db = createTenantDb(executor, tenantId);
    const result = await registerReader(db, input);
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}
