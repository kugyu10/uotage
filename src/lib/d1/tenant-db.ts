/**
 * issue #11 [移行 P5]: RLS の代替 — 全クエリに tenant_id フィルタを強制する共通ラッパ。
 *
 * D1 (SQLite) に行レベルセキュリティは無く、Postgres で 14 ポリシーと is_tenant_operator()
 * が担っていたテナント分離はアプリコードの責務になる。「where tenant_id = ? の付け忘れが
 * そのまま情報漏洩になる」状況を、規約ではなく実行時の構造で防ぐのがこのモジュール。
 *
 * 仕組み:
 *   - テナント分離対象のテーブル（TENANT_SCOPED_TABLES）に触れる SQL は、
 *     `tenant_id = :tenant` というマーカーを含まない限り実行前に例外で拒否する。
 *   - `:tenant` の値は呼び出し側が渡すのではなく、createTenantDb(executor, tenantId) が
 *     束縛した tenantId が必ず入る。呼び出し側は自分以外のテナントIDをバインドできない。
 *   - 素の executor（db.prepare 相当）はこのモジュールの外に持ち出さない運用にする
 *     （test/unit/d1-tenant-db.test.ts が越境の失敗を CI で固定する）。
 *
 * 限界（正直に書く）:
 *   - マーカー検査は「1文につき最低1箇所」であり、join した複数テーブルの各々に
 *     フィルタが付いているかまでは静的に判定しない（`a join b` で a 側だけ絞って
 *     b 側を絞り忘れる、は防げない）。join を含む SQL はレビューで各テーブルの
 *     スコープを確認すること。
 *   - `tenant_id = :tenant or 1=1` のような意図的な迂回は防げない。これは悪意ある
 *     開発者ではなく「付け忘れ」という事故を防ぐための装置である。
 */

type SqlParam = string | number | null;

/** D1 / node:sqlite を薄く包む実行器。delivery-queue の QueueDb と同じ形。 */
export interface D1Executor {
  all<T>(sql: string, params: readonly SqlParam[]): Promise<T[]>;
  run(sql: string, params: readonly SqlParam[]): Promise<void>;
}

/**
 * tenant_id 列を持ち、必ずテナントで絞らなければならないテーブル。
 * D1 へ移すテーブルを増やしたら、ここに足すこと（足し忘れると検査対象にならない）。
 */
export const TENANT_SCOPED_TABLES = [
  "readers",
  "scenario_readers",
  "step_messages",
  "scenarios",
  "funnels",
  "products",
  "purchases",
  "labels",
  "reader_labels",
  "deliveries",
  "delivery_accounts",
  "operators",
] as const;

export class MissingTenantScopeError extends Error {
  constructor(sql: string, tables: readonly string[]) {
    super(
      `テナント分離対象のテーブル (${tables.join(", ")}) に触れる SQL に ` +
        `"tenant_id = :tenant" がありません。RLS の代替として必須です: ${sql.slice(0, 200)}`,
    );
    this.name = "MissingTenantScopeError";
  }
}

/** SQL が触れるテナント分離対象テーブルを列挙する（from / join / into / update の直後のみ見る）。 */
function touchedScopedTables(sql: string): string[] {
  const normalized = sql.toLowerCase();
  return TENANT_SCOPED_TABLES.filter((table) =>
    new RegExp(String.raw`\b(from|join|into|update)\s+${table}\b`).test(normalized),
  );
}

const TENANT_MARKER = ":tenant";

/**
 * テナント境界の検査。
 *   - select / update / delete: `tenant_id = :tenant` が必須。
 *   - insert: 列リストに tenant_id があり、値に `:tenant` を使っていること。
 *     insert ... select の形はコピー元も絞る必要があるため、加えて `tenant_id = :tenant` も必須。
 */
function hasTenantGuard(sql: string): boolean {
  const normalized = sql.toLowerCase();
  const hasEqMarker = normalized.includes(`tenant_id = ${TENANT_MARKER}`);
  const insertMatch = /^\s*insert\s+into\s+\w+\s*\(([^)]*)\)/.exec(normalized);
  if (insertMatch) {
    const columnsIncludeTenant = insertMatch[1]
      .split(",")
      .map((column) => column.trim())
      .includes("tenant_id");
    const insertsFromSelect = /\)\s*select\b/.test(normalized);
    if (insertsFromSelect) return columnsIncludeTenant && hasEqMarker;
    return columnsIncludeTenant && normalized.includes(TENANT_MARKER);
  }
  return hasEqMarker;
}

/**
 * `:tenant` を `?` に置き換え、束縛済み tenantId をパラメータ列の正しい位置に差し込む。
 * 呼び出し側の params は `?` の出現順のまま渡せばよい。
 */
function bindTenant(
  sql: string,
  params: readonly SqlParam[],
  tenantId: string,
): { sql: string; params: SqlParam[] } {
  const segments = sql.split(TENANT_MARKER);
  const bound: SqlParam[] = [];
  let consumed = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const placeholders = (segments[i].match(/\?/g) ?? []).length;
    for (let k = 0; k < placeholders; k += 1) {
      bound.push(params[consumed]);
      consumed += 1;
    }
    if (i < segments.length - 1) bound.push(tenantId);
  }
  if (consumed !== params.length) {
    throw new Error(`パラメータ数が一致しません: SQL の ? は ${consumed} 個、渡されたのは ${params.length} 個`);
  }
  return { sql: segments.join("?"), params: bound };
}

export interface TenantDb {
  readonly tenantId: string;
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
}

/**
 * tenantId を束縛したテナント境界つき DB を作る。
 * 認証済みオペレーターの tenant_id（requireOperator 相当）だけを渡すこと。
 */
export function createTenantDb(executor: D1Executor, tenantId: string): TenantDb {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("tenantId is required");
  }

  function prepare(sql: string, params: readonly SqlParam[]): { sql: string; params: SqlParam[] } {
    const scoped = touchedScopedTables(sql);
    if (scoped.length > 0 && !hasTenantGuard(sql)) {
      throw new MissingTenantScopeError(sql, scoped);
    }
    return bindTenant(sql, params, tenantId);
  }

  return {
    tenantId,
    async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const bound = prepare(sql, params);
      return executor.all<T>(bound.sql, bound.params);
    },
    async get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
      const rows = await this.all<T>(sql, params);
      return rows[0];
    },
    async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
      const bound = prepare(sql, params);
      await executor.run(bound.sql, bound.params);
    },
  };
}
