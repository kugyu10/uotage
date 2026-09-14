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
 *   - `tenants` テーブル自体は tenant_id 列を持たず id が境界になるため、
 *     `id = :tenant` マーカーを別途要求する（TENANT_ID_KEYED_TABLES）。
 *   - insert では列リストの中で tenant_id が実際に置かれている位置の値が
 *     厳密に `:tenant` であることまで検査する（列の並び違いによる付け違いを防ぐ）。
 *   - update で `set` 句が tenant_id を再代入しようとしている場合は常に拒否する
 *     （テナント間で行を付け替える正当な用途は無い）。
 *   - `:tenant` の値は呼び出し側が渡すのではなく、createTenantDb(executor, tenantId) が
 *     束縛した tenantId が必ず入る。呼び出し側は自分以外のテナントIDをバインドできない。
 *   - マーカー・テーブル名の検査は文字列リテラルやコメントの中身を見ない
 *     （リテラル中に偶然 `tenant_id = :tenant` 等の文字列があっても誤判定しない）。
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
 *   - `tenantId` の値そのものが正しい（requireOperator 相当で解決済み）ことは
 *     このモジュールでは強制できない。呼び出し規約として守ること（ADR 参照）。
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
 * test/unit/d1-tenant-db.test.ts が Postgres 初期スキーマとの突き合わせで漏れを検出する。
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
  "registration_paths",
] as const;

/**
 * tenant_id 列を持たず、id 自体がテナント境界になるテーブル。
 * `select * from tenants` は `where id = :tenant` が無いと全テナント行を返してしまう。
 */
export const TENANT_ID_KEYED_TABLES = ["tenants"] as const;

export class MissingTenantScopeError extends Error {
  constructor(sql: string, tables: readonly string[]) {
    super(
      `テナント分離対象のテーブル (${tables.join(", ")}) に触れる SQL に ` +
        `テナント境界のマーカーがありません。RLS の代替として必須です: ${sql.slice(0, 200)}`,
    );
    this.name = "MissingTenantScopeError";
  }
}

export class TenantReassignmentError extends Error {
  constructor(sql: string) {
    super(
      `update の set 句で tenant_id を再代入しようとしています。テナント間で行を ` +
        `付け替える正当な用途は無いため拒否します: ${sql.slice(0, 200)}`,
    );
    this.name = "TenantReassignmentError";
  }
}

/**
 * SQL 中の文字列リテラル（'...'、'' エスケープ含む）と -- / \/* *\/ コメントを
 * 同じ長さのまま空白で潰す。元の文字インデックスがそのまま保たれるため、
 * ここで見つけた位置は元の SQL 文字列に対してもそのまま使える。
 */
function maskLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      out += " ";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out += " ";
          i += 1;
          break;
        }
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 識別子の引用符（" ` [ ]）を取り除く（マッチ判定専用。位置合わせは不要な用途でのみ使う）。 */
function stripIdentifierQuotes(s: string): string {
  return s.replace(/["`[\]]/g, "");
}

/** かっこの深さを見ながらトップレベルのカンマだけで分割する（関数呼び出し等のネストを壊さない）。 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * masked（リテラル・コメント除去済み）SQL の中で、from / join / into / update の直後に
 * 現れるテーブル名を探す。schema 修飾（main.readers）・引用符（"readers" / `readers`）を
 * 剥がしてから照合するため、それらで検出をすり抜けない。
 */
function touchedTables(masked: string, tables: readonly string[]): string[] {
  const search = stripIdentifierQuotes(masked.toLowerCase());
  return tables.filter((table) =>
    new RegExp(String.raw`\b(from|join|into|update)\s+(\w+\.)?${table}\b`).test(search),
  );
}

/**
 * 先頭から、かっこの深さを見ながらトップレベルの `(...)` グループを連続して取り出す。
 * グループの間はカンマ・空白のみ許容し、それ以外の文字（`on conflict` 等）に出会ったら止める。
 * `values (a, b), (c, d)` のような多値 insert の全タプルを取り出すために使う。
 */
function extractParenGroups(s: string): string[] {
  const groups: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i += 1;
    if (i < n && s[i] === ",") {
      i += 1;
      continue;
    }
    if (i >= n || s[i] !== "(") break;
    const start = i;
    let depth = 0;
    for (; i < n; i += 1) {
      if (s[i] === "(") depth += 1;
      else if (s[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    groups.push(s.slice(start + 1, i - 1));
  }
  return groups;
}

/**
 * insert into <table> (<cols>) values (<vals>), (<vals>), ... の列リストと、
 * **全ての** VALUES タプルを取り出す（無ければ null）。
 * 旧実装は正規表現が最初の1タプルしか捕まえられず、多値 insert の2行目以降が
 * 無検査ですり抜けていた（PR #22 レビュー 🟡A）。
 */
function parseInsertColumnsAndValues(masked: string): { columns: string[]; valueTuples: string[][] } | null {
  const match = /insert\s+into\s+[\w."`[\]]+\s*\(([^)]*)\)\s*values\s*([\s\S]*)/i.exec(masked);
  if (!match) return null;
  const columns = splitTopLevel(match[1]).map((c) => stripIdentifierQuotes(c).trim().toLowerCase());
  const tupleStrings = extractParenGroups(match[2]);
  if (tupleStrings.length === 0) return null;
  const valueTuples = tupleStrings.map((t) => splitTopLevel(t).map((v) => v.trim()));
  return { columns, valueTuples };
}

/**
 * insert の列リストで tenant_id が置かれている「位置」の値が、**全タプルについて**
 * 厳密に `:tenant` であることを確認する。列リストに tenant_id はあるが値の位置が
 * ずれている（列の並べ間違い）タプルが1つでもあれば false。
 */
function insertColumnPositionOk(masked: string): boolean {
  const parsed = parseInsertColumnsAndValues(masked);
  if (!parsed) return false;
  const idx = parsed.columns.indexOf("tenant_id");
  if (idx === -1) return false;
  return parsed.valueTuples.every((tuple) => idx < tuple.length && /^:tenant$/i.test(tuple[idx]));
}

/**
 * insert ... select の列リストと select の projection リストを、位置で1対1に対応させて
 * tenant_id 列の位置の projection 式が厳密に `:tenant` であることを確認する。
 * `select *` や `union` を含む形は静的に安全と判定できないため素直に false（拒否）にする
 * （PR #22 レビュー 🟡A: 「select 由来のため位置検査は意味を持たない」は誤りだった）。
 */
function insertSelectColumnPositionOk(masked: string): boolean {
  const match = /insert\s+into\s+[\w."`[\]]+\s*\(([^)]*)\)\s*select\s+([\s\S]*?)\s+from\b/i.exec(masked);
  if (!match) return false;
  const columns = splitTopLevel(match[1]).map((c) => stripIdentifierQuotes(c).trim().toLowerCase());
  const idx = columns.indexOf("tenant_id");
  if (idx === -1) return false;
  const projection = splitTopLevel(match[2]).map((v) => v.trim());
  if (projection.some((p) => p.includes("*"))) return false;
  if (idx >= projection.length) return false;
  if (/\bunion\b/i.test(masked)) return false;
  return /^:tenant$/i.test(projection[idx]);
}

/**
 * テナント境界の検査（masked 済み SQL を受け取る）。
 *   - select / update / delete: `tenant_id = :tenant` が必須。
 *   - insert ... values: 列リストの tenant_id の位置の値が、全 VALUES タプルについて
 *     厳密に `:tenant` であること。
 *   - insert ... select: コピー元も絞る必要があるため、列リストの tenant_id の位置に
 *     対応する projection 式が厳密に `:tenant` であること（列の並べ間違いを検出できる）。
 */
function hasTenantGuard(masked: string): boolean {
  const isInsert = /^\s*insert\s+into\s+[\w."`[\]]+\s*\(/i.test(masked);
  if (isInsert) {
    const insertsFromSelect = /\)\s*select\b/i.test(masked);
    if (insertsFromSelect) {
      return insertSelectColumnPositionOk(masked);
    }
    return insertColumnPositionOk(masked);
  }
  const hasEqMarker = /tenant_id\s*=\s*:tenant\b/i.test(masked);
  return hasEqMarker;
}

/**
 * `update ... set ...` および upsert の `insert ... on conflict ... do update set ...` の
 * set 句が tenant_id を再代入しようとしていないかを確認する。
 * 旧実装は (1) 文頭が `update` の文にしか発火せず `on conflict ... do update set` をすり抜け、
 * (2) 左辺の引用識別子 `"tenant_id"` を剥がしていなかったため検出をすり抜けていた
 * （PR #22 レビュー 🟡B）。
 */
function reassignsTenantId(masked: string): boolean {
  const match = /\bset\s+([\s\S]*?)(\bwhere\b[\s\S]*|\breturning\b[\s\S]*)?$/i.exec(masked);
  if (!match) return false;
  const setClause = match[1];
  return splitTopLevel(setClause).some((assignment) => {
    const left = stripIdentifierQuotes(assignment).trim();
    return /^tenant_id\b\s*=/i.test(left);
  });
}

/**
 * `:tenant` を `?` に置き換え、束縛済み tenantId をパラメータ列の正しい位置に差し込む。
 * 呼び出し側の params は `?` の出現順のまま渡せばよい。
 * リテラル・コメント中の `?` / `:tenant` は masked 側で除外されているため数え上げに影響しない。
 */
function bindTenant(
  sql: string,
  params: readonly SqlParam[],
  tenantId: string,
): { sql: string; params: SqlParam[] } {
  const masked = maskLiteralsAndComments(sql);
  const markerPattern = /:tenant\b/gi;
  const segments: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(masked)) !== null) {
    segments.push(sql.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }
  segments.push(sql.slice(lastIndex));

  const bound: SqlParam[] = [];
  let consumed = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const maskedSegment = maskLiteralsAndComments(segments[i]);
    const placeholders = (maskedSegment.match(/\?/g) ?? []).length;
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
    const masked = maskLiteralsAndComments(sql);
    const scoped = touchedTables(masked, TENANT_SCOPED_TABLES);
    const idKeyed = touchedTables(masked, TENANT_ID_KEYED_TABLES);

    if (scoped.length > 0) {
      if (!hasTenantGuard(masked)) {
        throw new MissingTenantScopeError(sql, scoped);
      }
      if (reassignsTenantId(masked)) {
        throw new TenantReassignmentError(sql);
      }
    } else if (idKeyed.length > 0) {
      if (!/\bid\s*=\s*:tenant\b/i.test(masked)) {
        throw new MissingTenantScopeError(sql, idKeyed);
      }
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
