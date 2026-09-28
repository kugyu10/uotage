/**
 * issue #29 [移行 P5] レビュー 🟡-7: `workers/tenant-do/src/index.ts` の
 * `TenantDurableObject.tenantId()` からロジックだけを切り出したもの。
 *
 * 切り出す理由: `workers/tenant-do` は Cloudflare Workers 型（DurableObjectId 等）に
 * 依存しており、ルート側の `tsconfig.json` / `eslint.config.mjs` の対象外かつ
 * どのテストからも import されない（README 参照）。DOクラス本体をテストしようとすると
 * Cloudflare 型のモックが要り、テナント境界ガードという単純なロジックのテストとして
 * 過剰である。`DurableObjectId.name` を受け取って tenantId を解決する部分だけを
 * Cloudflare 型に依存しない純関数として切り出し、ルート側の `npm test` で直接検証する。
 *
 * 呼び出し側（workers/tenant-do/src/index.ts）は `this.ctx.id.name` をそのまま渡すだけの
 * 薄い糊にする。**呼び出し側がこの関数を実際に使っているか**（= tenantId() を経由せず
 * 固定文字列を createTenantDb に渡すような改変が起きていないか）はこの関数のテストだけでは
 * 守れない（facts.md の重点観点）。それを補うのが README の「呼び出し側の確認」であり、
 * 将来 workers/tenant-do 側に軽量なテストランナーを足す余地として申し送る（このPRのスコープ外）。
 */

/**
 * `env.TENANT_DO.idFromName(tenantId)` で作った DurableObjectId の `name` から
 * テナントIDを解決する。`idFromName` 以外（`newUniqueId` 等）で作られた ID は
 * `name` を持たないため、空文字列や undefined で `createTenantDb` を呼んでしまう
 * 事故を防ぐためにここで拒否する（`createTenantDb` 自身も空文字列を拒否するが、
 * ここでより早く分かりやすいメッセージで落とす）。
 */
export function resolveTenantIdFromDoName(name: string | null | undefined): string {
  if (!name) {
    throw new Error("TenantDurableObject は idFromName(tenantId) で解決したIDでのみ呼び出せます。");
  }
  return name;
}
