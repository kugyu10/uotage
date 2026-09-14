// issue #11 [移行 P5]: RLS 代替のテナント強制ラッパ。
// 「テナント越境を試みるテストを追加し、CI で回す」（issue のやること）に対応する。
// node:sqlite の実 DB に2テナント分のデータを入れ、越境がブロックされることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createTenantDb,
  MissingTenantScopeError,
  TenantReassignmentError,
  TENANT_SCOPED_TABLES,
  type D1Executor,
} from "../../src/lib/d1/tenant-db.ts";

function createExecutor(): { db: DatabaseSync; executor: D1Executor } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table readers (id text primary key, tenant_id text not null, email text not null);
    create table labels (id text primary key, tenant_id text not null, name text not null);
    create table tenants (id text primary key, name text not null);
  `);
  const seed = db.prepare("insert into readers (id, tenant_id, email) values (?, ?, ?)");
  seed.run("r1", "tenant-a", "a@example.com");
  seed.run("r2", "tenant-b", "b@example.com");
  const seedTenant = db.prepare("insert into tenants (id, name) values (?, ?)");
  seedTenant.run("tenant-a", "Tenant A");
  seedTenant.run("tenant-b", "Tenant B");
  const executor: D1Executor = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
      // node:sqlite の行は null プロトタイプで deepEqual と相性が悪いため plain object に写す。
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return Promise.resolve(rows.map((row) => ({ ...row })) as T[]);
    },
    run(sql: string, params: readonly (string | number | null)[]) {
      db.prepare(sql).run(...params);
      return Promise.resolve();
    },
  };
  return { db, executor };
}

test("tenant_id = :tenant 付きのクエリは、束縛したテナントの行しか返さない", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  const rows = await tenantA.all<{ id: string; email: string }>(
    "select id, email from readers where tenant_id = :tenant order by id",
  );

  assert.deepEqual(rows, [{ id: "r1", email: "a@example.com" }]);
});

test("越境の試み: 分離対象テーブルへのフィルタ無しクエリは実行前に拒否される", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // select / update / delete / insert-select いずれもマーカー無しでは実行させない。
  await assert.rejects(() => tenantA.all("select * from readers"), MissingTenantScopeError);
  await assert.rejects(
    () => tenantA.run("update readers set email = ? where id = ?", ["x@example.com", "r2"]),
    MissingTenantScopeError,
  );
  await assert.rejects(() => tenantA.run("delete from readers where id = ?", ["r2"]), MissingTenantScopeError);
  await assert.rejects(
    () => tenantA.run("insert into readers (id, tenant_id, email) select id, tenant_id, email from readers"),
    MissingTenantScopeError,
  );
});

test("越境の試み: 他テナントの id を直接指定しても、tenant フィルタで空振りする", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // r2 は tenant-b の行。id を知っていても tenant_id = :tenant が付くため触れない。
  const row = await tenantA.get("select id from readers where tenant_id = :tenant and id = ?", ["r2"]);
  assert.equal(row, undefined);

  await tenantA.run("update readers set email = ? where tenant_id = :tenant and id = ?", ["evil@example.com", "r2"]);
  const untouched = db.prepare("select email from readers where id = ?").get("r2") as { email: string };
  assert.equal(untouched.email, "b@example.com", "他テナントの行が書き換えられた");
});

test(":tenant には createTenantDb で束縛した tenantId が入る（呼び出し側は別テナントをバインドできない）", async () => {
  const { executor } = createExecutor();
  const tenantB = createTenantDb(executor, "tenant-b");

  // パラメータ位置が混在しても、:tenant の位置に正しく tenant-b が入る。
  const rows = await tenantB.all<{ id: string }>(
    "select id from readers where email <> ? and tenant_id = :tenant and id <> ? order by id",
    ["nobody@example.com", "zzz"],
  );
  assert.deepEqual(rows, [{ id: "r2" }]);
});

test("insert にもテナントが強制でき、パラメータ数の不一致は検出される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await tenantA.run("insert into labels (id, tenant_id, name) values (?, :tenant, ?)", ["l1", "VIP"]);
  const inserted = db.prepare("select tenant_id from labels where id = ?").get("l1") as { tenant_id: string };
  assert.equal(inserted.tenant_id, "tenant-a");

  await assert.rejects(
    () => tenantA.run("insert into labels (id, tenant_id, name) values (?, :tenant, ?)", ["l2"]),
    /パラメータ数が一致しません/,
  );
});

test("分離対象外のテーブル（例: スキーマ情報）はマーカー無しでも通る", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  const tables = await tenantA.all<{ name: string }>(
    "select name from sqlite_master where type = 'table' order by name",
  );
  assert.deepEqual(
    tables.map((table) => table.name),
    ["labels", "readers", "tenants"],
  );
});

test("PR #22 レビュー 🟡3: insert の列と値がずれていると（tenant_id の位置に別値）拒否される", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 列リストには tenant_id があるが、値の位置が呼び出し側の任意値になっている（位置ずれ）。
  await assert.rejects(
    () =>
      tenantA.run("insert into readers (tenant_id, id, email) values (?, ?, :tenant)", [
        "evil-tenant",
        "r3",
      ]),
    MissingTenantScopeError,
  );
});

test("PR #22 レビュー 🟡4: update の set 句で tenant_id を付け替えようとすると拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run("update readers set tenant_id = ? where tenant_id = :tenant and id = ?", [
        "evil-tenant",
        "r1",
      ]),
    TenantReassignmentError,
  );
  const untouched = db.prepare("select tenant_id from readers where id = ?").get("r1") as {
    tenant_id: string;
  };
  assert.equal(untouched.tenant_id, "tenant-a", "行が別テナントへ付け替えられた");
});

test("PR #22 レビュー 🟡5: schema 修飾・引用符付きテーブル名でもガードが効く", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => tenantA.all("select * from main.readers"), MissingTenantScopeError);
  await assert.rejects(() => tenantA.all('select * from "readers"'), MissingTenantScopeError);
});

test("PR #22 レビュー 🟢8: マーカー検査は空白・大文字小文字に寛容で、束縛も一致する", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 空白なし
  const rowsNoSpace = await tenantA.all<{ id: string }>(
    "select id from readers where tenant_id=:tenant order by id",
  );
  assert.deepEqual(rowsNoSpace, [{ id: "r1" }]);

  // 大文字マーカー（bindTenant 側も同じ位置を認識して束縛できること）
  const rowsUpper = await tenantA.all<{ id: string }>(
    "select id from readers where tenant_id = :TENANT order by id",
  );
  assert.deepEqual(rowsUpper, [{ id: "r1" }]);
});

test("PR #22 レビュー 🟢9: tenants テーブルは id = :tenant が無いと拒否される", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => tenantA.all("select * from tenants"), MissingTenantScopeError);

  const rows = await tenantA.all<{ id: string }>("select id from tenants where id = :tenant");
  assert.deepEqual(rows, [{ id: "tenant-a" }]);
});

test("PR #22 レビュー 🟢10: 文字列リテラル中の ? や :tenant はパラメータ数え上げに影響しない", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  const rows = await tenantA.all<{ id: string }>(
    "select id from readers where tenant_id = :tenant and email <> '?:tenant?' and id <> ? order by id",
    ["zzz"],
  );
  assert.deepEqual(rows, [{ id: "r1" }]);
});

test("D1 へ移す予定の全テーブルが分離対象リストに載っている", async () => {
  // ハードコードした表と TENANT_SCOPED_TABLES を突き合わせると同語反復になり、
  // テーブル追加時の漏れを検出できない（PR #22 レビュー指摘）。
  // 実際の Postgres 初期スキーマから tenant_id 列を持つテーブルを抽出して突き合わせる。
  const { readFile } = await import("node:fs/promises");
  const migrationUrl = new URL(
    "../../supabase/migrations/20260813104008_initial_phase1_schema.sql",
    import.meta.url,
  );
  const sql = await readFile(migrationUrl, "utf8");

  const tenantScopedInSchema: string[] = [];
  const tableBlockPattern = /create table public\.(\w+) \(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(tableBlockPattern)) {
    const [, tableName, body] = match;
    if (/\btenant_id\b/.test(body)) {
      tenantScopedInSchema.push(tableName);
    }
  }

  // 抽出自体が壊れていないことの下限チェック（0件や極端に少ない件数で緑になるのを防ぐ）。
  assert.ok(
    tenantScopedInSchema.length >= 13,
    `スキーマから抽出できた tenant_id 保持テーブルが少なすぎます: ${tenantScopedInSchema.join(", ")}`,
  );

  for (const table of tenantScopedInSchema) {
    assert.ok(
      (TENANT_SCOPED_TABLES as readonly string[]).includes(table),
      `${table} は Postgres スキーマで tenant_id を持つが TENANT_SCOPED_TABLES に無い`,
    );
  }
});
