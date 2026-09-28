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
 * （`tenantId()` が id.name を要求する）。
 *
 * 未実装（issue #29 の残タスク。register_reader / import_scenario_readers の移植時に追加）:
 *   - registerReader RPC メソッド
 *   - importScenarioReaders RPC メソッド
 *
 * 未検証（このIssueの作業時点。UAT 集約Issue #13 へ）:
 *   - 実際の Cloudflare 環境での DO 作成・D1 バインディングの疎通
 *   - 同一テナントへの同時リクエストが実際にシリアライズされること
 *     （DO の input/output gate は `ctx.storage` への操作は自動的に守るが、
 *     `env.DB`（D1 バインディング）への fetch はその対象外という理解でいる。
 *     この理解が正しいかは実機で未確認。もし正しければ、Stripe webhook が
 *     ほぼ同時に2回届いた場合に processStripePurchase 内の「読む→書く」区間が
 *     割り込まれうる。詳細は processStripePurchase のコメント参照）
 */
import { DurableObject } from "cloudflare:workers";

import { createTenantDb, type D1Executor } from "../../../src/lib/d1/tenant-db.ts";

// tenant-db.ts はこの型を export していない（変更禁止 — #25/#28 で塞いだガードの
// 対象ファイル。呼び出すだけに留める）ため、D1Executor のメソッドシグネチャから
// 同じ形をここで再定義する。
type SqlParam = string | number | null;
import {
  processStripePurchase,
  type ProcessStripePurchaseInput,
} from "../../../src/lib/purchases/process-stripe-purchase.ts";

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

export interface RpcResult {
  ok: boolean;
  /** 失敗時のみ。Error#message。 */
  error?: string;
  /** 失敗時のみ。Error#name（呼び出し側が ProductNotFoundError 等を判別するのに使う）。 */
  errorName?: string;
}

export class TenantDurableObject extends DurableObject<Env> {
  /**
   * このDOインスタンスが担当するテナントID。呼び出し側が
   * `env.TENANT_DO.idFromName(tenantId)` で作った ID の `name` から取る。
   * `idFromName` 以外で作られた ID（name を持たない）で呼ばれたら例外にする —
   * テナント境界を誤って空文字列や undefined で createTenantDb に渡してしまう
   * 事故を防ぐため（createTenantDb 自体も空文字列を拒否するが、ここでより早く
   * 分かりやすいメッセージで落とす）。
   */
  private tenantId(): string {
    const name = this.ctx.id.name;
    if (!name) {
      throw new Error(
        "TenantDurableObject は idFromName(tenantId) で解決したIDでのみ呼び出せます。",
      );
    }
    return name;
  }

  /**
   * process_stripe_purchase の移植版を、このテナントのDOの中で実行する。
   * RPC (Workers RPC) として呼び出す想定: `env.TENANT_DO.idFromName(tenantId).processStripePurchase(input)`。
   *
   * 例外を投げずに `{ ok, error, errorName }` を返す。呼び出し側（Stripe webhook
   * ハンドラ、このIssueのスコープ外）が errorName で分岐できるようにするため
   * （例: ProductNotFoundError なら 4xx 相当、それ以外は 5xx でリトライさせる、等）。
   */
  async processStripePurchase(input: ProcessStripePurchaseInput): Promise<RpcResult> {
    const db = createTenantDb(createD1Executor(this.env.DB), this.tenantId());
    try {
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
}

export default {
  // このワーカーは Durable Object クラスの export が目的で、HTTPリクエストは
  // 受け付けない（RPC 経由でのみ呼ばれる想定。workers/dispatch-cron の
  // scheduled専用ワーカーと同じ考え方）。
  async fetch(): Promise<Response> {
    return new Response("uotage-tenant-do: RPC専用。fetch は未提供。", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
