// issue #11 [移行 P5]: RLS 代替のテナント強制ラッパ。
// 「テナント越境を試みるテストを追加し、CI で回す」（issue のやること）に対応する。
// node:sqlite の実 DB に2テナント分のデータを入れ、越境がブロックされることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createTenantDb,
  MissingTenantScopeError,
  TENANT_SCOPED_TABLES,
  type D1Executor,
} from "../../src/lib/d1/tenant-db.ts";

function createExecutor(): { db: DatabaseSync; executor: D1Executor } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table readers (id text primary key, tenant_id text not null, email text not null);
    create table labels (id text primary key, tenant_id text not null, name text not null);
  `);
  const seed = db.prepare("insert into readers (id, tenant_id, email) values (?, ?, ?)");
  seed.run("r1", "tenant-a", "a@example.com");
  seed.run("r2", "tenant-b", "b@example.com");
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
    ["labels", "readers"],
  );
});

test("D1 へ移す予定の全テーブルが分離対象リストに載っている", () => {
  // Postgres 初期スキーマの tenant_id を持つテーブル群。リストから漏れると検査対象外になるため固定する。
  for (const table of [
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
  ]) {
    assert.ok(
      (TENANT_SCOPED_TABLES as readonly string[]).includes(table),
      `${table} が TENANT_SCOPED_TABLES に無い`,
    );
  }
});
