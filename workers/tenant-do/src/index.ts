/**
 * issue #29 [移行 P5] ADR 方式A（docs/移行P5-ADR-トランザクション設計.md）:
 * テナント単位で書き込みを直列化する Durable Object。
 *
 * このワーカーは D1 バインディング (`env.DB`) を持つが、業務データ自体は
 * TenantDurableObject 自身のストレージ (`ctx.storage`) には置かない。
 * 実データは共有 D1 (uotage-db) 側にあり、DO の役割は「同一テナントに対する
 * 読む→判断する→書く の並行実行を防ぐ実行モデル」を提供すること。
 *
 * 呼び出し側の前提（現状のスケルトン段階の制約。呼び出し元の実装は
 * このIssueのスコープ外 — root wrangler.jsonc の TENANT_DO バインディング越しに
 * `env.TENANT_DO.idFromName(tenantId)` で得た stub を使うこと。
 * `idFromName` 以外（`newUniqueId` 等）で作った ID には対応していない
 * （`src/lib/d1/resolve-tenant-id.ts` の `resolveTenantIdFromDoName` が id.name を要求する）。
 *
 * 直列化について（確定事項。レビュー 🔴-1 で判明）:
 *   DO の input/output gate は `ctx.storage`（DO 自身のストレージ）への操作しか自動で
 *   守らない。`env.DB`（D1 バインディング）への fetch は non-storage I/O のため gate の
 *   対象外——これは実機を待つまでもなく Cloudflare 公式ドキュメントで確定している
 *   （https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
 *   「Input gates only protect during storage operations. Non-storage I/O like fetch() ...
 *   allows other requests to interleave」）。そのため各 RPC メソッドは
 *   `ctx.blockConcurrencyWhile()` で「読む→書く」区間全体を明示的に囲み、
 *   同一テナントへの同時呼び出しを直列化している（公式ドキュメントが
 *   「外部 async 呼び出し中の状態変化を許容できない場合」の用途として挙げている使い方）。
 *
 * 注意（レビュー 🟢-4）: `ctx.blockConcurrencyWhile()` のコールバックには
 * **30秒のタイムアウト**があり、超えると DO 自体がリセットされる
 * （公式 https://developers.cloudflare.com/durable-objects/api/state/ 「there is a
 * 30 second timeout applied when executing the callback」）。deliveries 一括insertは
 * ステップ数に比例してチャンク数が線形に増える（process-stripe-purchase.ts 参照）ため、
 * 将来このコールバックの中に重い処理を足すときはこの制限を意識すること。
 *
 * 未検証（このIssueの作業時点。UAT 集約Issue #13 へ）:
 *   - 実際の Cloudflare 環境での DO 作成・D1 バインディングの疎通
 *   - 実機で blockConcurrencyWhile が意図通り同時リクエストを直列化していること
 *     （ロジック上の直列化点は上記で確定したが、実機での挙動確認は別）
 */
import { DurableObject } from "cloudflare:workers";

import type { D1Executor } from "../../../src/lib/d1/tenant-db.ts";
import { runProcessStripePurchaseRpc, type RpcResult } from "../../../src/lib/d1/process-stripe-purchase-rpc.ts";
import type { ProcessStripePurchaseInput } from "../../../src/lib/purchases/process-stripe-purchase.ts";
import { runRegisterReaderRpc, type RegisterReaderRpcResult } from "../../../src/lib/d1/register-reader-rpc.ts";
import type { RegisterReaderInput } from "../../../src/lib/readers/register-reader.ts";
import {
  runImportScenarioReadersRpc,
  type ImportScenarioReadersRpcResult,
} from "../../../src/lib/d1/import-scenario-readers-rpc.ts";
import type { ImportScenarioReadersInput } from "../../../src/lib/readers/import-scenario-readers.ts";

// tenant-db.ts はこの型を export していない（変更禁止 — #25/#28 で塞いだガードの
// 対象ファイル。呼び出すだけに留める）ため、D1Executor のメソッドシグネチャから
// 同じ形をここで再定義する。
type SqlParam = string | number | null;

export interface Env {
  DB: D1Database;
}

/**
 * D1Database（Cloudflare Workers の実バインディング）を、tenant-db.ts が要求する
 * D1Executor 形に薄く包む。src/lib/delivery-queue/claim.ts のコメントに書かれている
 * 変換と同じ形（all = .prepare().bind().all().then(r => r.results), run = .run()）。
 *
 * D1Database 型に依存するアダプタなので、Cloudflare Workers 型を持たないルート側
 * (src/lib) には置かず、こちら（@cloudflare/workers-types を持つ workers/tenant-do）
 * 側に置く。
 */
export function createD1Executor(db: D1Database): D1Executor {
  return {
    async all<T>(sql: string, params: readonly SqlParam[]): Promise<T[]> {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return result.results;
    },
    async run(sql: string, params: readonly SqlParam[]): Promise<void> {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
  };
}

export class TenantDurableObject extends DurableObject<Env> {
  /**
   * process_stripe_purchase の移植版を、このテナントのDOの中で実行する。
   * RPC (Workers RPC) として呼び出す想定: `env.TENANT_DO.idFromName(tenantId).processStripePurchase(input)`。
   *
   * テナントID解決（idFromName の name から）・テナント境界つき DB の組み立て・実行・
   * 例外の `{ ok, error, errorName }` への変換は `runProcessStripePurchaseRpc`
   * （Cloudflare型非依存、ルート側の npm test で検証済み）に切り出してある。
   * ここは `this.ctx.id.name` と D1Executor を渡すだけの薄い糊
   * （Cloudflare型が無いと書けない部分だけ。レビュー 🟡-7）。
   *
   * `ctx.blockConcurrencyWhile()` で処理全体を囲む（ヘッダの「直列化について」参照）。
   * D1 への fetch は input/output gate の対象外なので、これが無いと同一テナントへの
   * ほぼ同時の2回の呼び出しで `processStripePurchase` 内の「読む→書く」区間が
   * 割り込まれうる。
   */
  async processStripePurchase(input: ProcessStripePurchaseInput): Promise<RpcResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      runProcessStripePurchaseRpc(createD1Executor(this.env.DB), this.ctx.id.name, input),
    );
  }

  /**
   * register_reader の移植版を、このテナントのDOの中で実行する。
   * RPC (Workers RPC) として呼び出す想定: `env.TENANT_DO.idFromName(tenantId).registerReader(input)`。
   *
   * processStripePurchase と同じ構造（薄い糊 + blockConcurrencyWhile による直列化）。
   * `registerReader` 自身は Resend を呼ばない（src/lib/readers/register-reader.ts の
   * ヘッダコメント参照）。実際のメール送信は呼び出し側（このIssueのスコープ外）が
   * `RegisterReaderRpcResult.result` の subject/body/initialDeliveryId を見て行う。
   */
  async registerReader(input: RegisterReaderInput): Promise<RegisterReaderRpcResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      runRegisterReaderRpc(createD1Executor(this.env.DB), this.ctx.id.name, input),
    );
  }

  /**
   * import_scenario_readers の移植版を、このテナントのDOの中で実行する。
   * RPC (Workers RPC) として呼び出す想定:
   * `env.TENANT_DO.idFromName(tenantId).importScenarioReaders(input)`。
   *
   * processStripePurchase / registerReader と同じ構造（薄い糊 + blockConcurrencyWhile
   * による直列化）。呼び出し側はCSVインポートの確定実行を IMPORT_BATCH_SIZE 件ずつに
   * 分割し、この RPC を1バッチにつき1回呼ぶ想定
   * （src/lib/readers/import-scenario-readers.ts のヘッダコメント参照。
   * `input.executedAt` は全バッチで同一の値を渡すこと）。
   */
  async importScenarioReaders(input: ImportScenarioReadersInput): Promise<ImportScenarioReadersRpcResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      runImportScenarioReadersRpc(createD1Executor(this.env.DB), this.ctx.id.name, input),
    );
  }
}

export default {
  // このワーカーは Durable Object クラスの export が目的で、HTTPリクエストは
  // 受け付けない（RPC 経由でのみ呼ばれる想定。workers/dispatch-cron の
  // scheduled専用ワーカーと同じ考え方）。
  async fetch(): Promise<Response> {
    return new Response("uotage-tenant-do: RPC専用。fetch は未提供。", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
