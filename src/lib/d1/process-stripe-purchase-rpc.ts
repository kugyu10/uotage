/**
 * issue #29 [移行 P5] レビュー 🟡-7 (a): `workers/tenant-do/src/index.ts` の
 * `TenantDurableObject.processStripePurchase` RPC の中身を、Cloudflare Workers 型
 * （DurableObjectId・DurableObject 基底クラス等）に依存しない形で切り出したもの。
 *
 * 目的: `workers/tenant-do` はルートの tsconfig / eslint / npm test の対象外
 * （README 参照）で、DOクラス自体をテストする手段が無い。ここに切り出すことで
 * 「DO名からのテナントID解決 → createTenantDb → processStripePurchase 実行」という
 * “配線” 部分をルート側の npm test で直接検証できるようにする。これにより
 * `resolveTenantIdFromDoName` を切り出しただけでは防げなかった「呼び出し側が
 * 誤って固定のテナント名を渡す」「resolveTenantIdFromDoName を経由しない」といった
 * 事故もテストで検出できる。
 *
 * `workers/tenant-do/src/index.ts` 側に残るのは、`this.ctx.id.name` を渡し
 * `this.ctx.blockConcurrencyWhile()` で囲むだけの薄い糊（Cloudflare 型が無いと
 * 書けない部分だけ）。
 */
import { createTenantDb, type D1Executor } from "./tenant-db.ts";
import { resolveTenantIdFromDoName } from "./resolve-tenant-id.ts";
import { processStripePurchase, type ProcessStripePurchaseInput } from "../purchases/process-stripe-purchase.ts";

export interface RpcResult {
  ok: boolean;
  /** 失敗時のみ。Error#message。 */
  error?: string;
  /** 失敗時のみ。Error#name（呼び出し側が ProductNotFoundError 等を判別するのに使う）。 */
  errorName?: string;
}

/**
 * `processStripePurchase` を「DOインスタンス名からテナントIDを解決 → テナント境界つき DB を
 * 組み立てる → 実行する」まで含めて行う。例外は投げず `{ ok, error, errorName }` を返す
 * （呼び出し側の DOクラスが try/catch を書かずに済むようにするため）。
 *
 * `doName` は `this.ctx.id.name`（`idFromName(tenantId)` で作った ID の name）を
 * そのまま渡すこと。`idFromName` 以外で作られた ID や、テナントIDでない固定文字列を
 * 渡すとテナント境界が壊れるため、ここで resolveTenantIdFromDoName を必ず経由させる
 * （呼び出し側がこの関数を経由さえすれば、テナントID解決を誤りようがない構造にする）。
 */
export async function runProcessStripePurchaseRpc(
  executor: D1Executor,
  doName: string | null | undefined,
  input: ProcessStripePurchaseInput,
): Promise<RpcResult> {
  try {
    const tenantId = resolveTenantIdFromDoName(doName);
    const db = createTenantDb(executor, tenantId);
    await processStripePurchase(db, input);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
}
