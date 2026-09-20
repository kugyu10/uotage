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

test("PR #22 再レビュー 🟡A-1: 多値 insert の2タプル目以降も列位置検査される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 1タプル目は tenant_id 位置が :tenant で正しいが、2タプル目は別値になっている。
  await assert.rejects(
    () =>
      tenantA.run("insert into labels (id, tenant_id, name) values (?, :tenant, ?), (?, ?, ?)", [
        "l1",
        "A",
        "l2",
        "evil-tenant",
        "B",
      ]),
    MissingTenantScopeError,
  );
  const rows = db.prepare("select id from labels").all() as Array<{ id: string }>;
  assert.deepEqual(rows, [], "拒否された insert で行が作られていない");
});

test("PR #22 再レビュー 🟡A-2: insert-select の projection の位置ずれは拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 列リストは (tenant_id, id, name) だが projection は (id, :tenant, email) で位置がずれている。
  await assert.rejects(
    () =>
      tenantA.run(
        "insert into labels (tenant_id, id, name) select id, :tenant, email from readers where tenant_id = :tenant",
      ),
    MissingTenantScopeError,
  );

  // projection がプレースホルダで他テナントを注入しようとする形も拒否される。
  await assert.rejects(
    () =>
      tenantA.run(
        "insert into labels (tenant_id, id, name) select ?, id, email from readers where tenant_id = :tenant",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );
  const rows = db.prepare("select id from labels").all() as Array<{ id: string }>;
  assert.deepEqual(rows, [], "拒否された insert-select で行が作られていない");
});

test("PR #22 再レビュー 🟡A-3: 列位置が正しい insert-select は許可される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await tenantA.run(
    "insert into labels (id, tenant_id, name) select id, :tenant, email from readers where tenant_id = :tenant",
  );
  const rows = (
    db.prepare("select id, tenant_id from labels").all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ id: "r1", tenant_id: "tenant-a" }]);
});

test("PR #22 再レビュー 🟡A-4: insert-select で select * は静的判定できないため拒否される", async () => {
  const { executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run(
        "insert into labels (id, tenant_id, name) select * from readers where tenant_id = :tenant",
      ),
    MissingTenantScopeError,
  );
});

test("PR #22 再レビュー round3 🟡F: insert-select のコピー元 (select) に tenant_id = :tenant の絞りが無ければ拒否される（回帰）", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 列位置は正しい（:tenant が tenant_id 列にマップされている）が、
  // コピー元 select 側に tenant_id = :tenant の絞りが無い。
  // 他テナント(tenant-b)の行 r2 まで自テナントの行として複製できてはならない。
  await assert.rejects(
    () =>
      tenantA.run(
        "insert into labels (tenant_id, id, name) select :tenant, id, email from readers",
      ),
    MissingTenantScopeError,
  );
  const rows = (
    db.prepare("select id, tenant_id from labels").all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [], "拒否された insert-select で行が作られていない");
});

test("issue #25 🟡G-1: insert or ignore も列位置検査の対象（位置ずれは拒否 / 正位置は通る）", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 列リストは (tenant_id, id, name) だが projection 先頭が呼び出し側の任意値。
  // 旧実装は isInsert が false になり列位置検査を丸ごとスキップしていた。
  await assert.rejects(
    () =>
      tenantA.run(
        "insert or ignore into labels (tenant_id, id, name) select ?, id, email from readers where tenant_id = :tenant",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );
  assert.deepEqual(db.prepare("select id from labels").all(), [], "拒否された insert で行が作られていない");

  // 列位置が正しい insert or ignore は従来どおり通ること（過剰拒否になっていない）。
  // values 形と select 形の両方を通す: 入口判定・VALUES 切り出し・select 切り出しの
  // 3箇所が同じパターンに揃っていないと、どれかがここで落ちる。
  await tenantA.run("insert or ignore into labels (id, tenant_id, name) values (?, :tenant, ?)", ["l1", "VIP"]);
  await tenantA.run(
    "insert or ignore into labels (id, tenant_id, name) select id, :tenant, email from readers where tenant_id = :tenant",
  );
  const rows = (
    db.prepare("select id, tenant_id from labels order by id").all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: "l1", tenant_id: "tenant-a" },
    { id: "r1", tenant_id: "tenant-a" },
  ]);
});

test("issue #25 🟡G-2: replace into / insert or replace は位置ずれも正位置も拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  // 位置ずれ（issue #25 が要求する回帰）。
  await assert.rejects(
    () =>
      tenantA.run(
        "replace into labels (tenant_id, id, name) select ?, id, email from readers where tenant_id = :tenant",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );

  // 列位置が正しくても拒否する。replace 系は主キー衝突した行を暗黙に DELETE するため、
  // 消える行が他テナントのものでないことを列位置検査では静的に否定できない。
  await assert.rejects(
    () => tenantA.run("replace into labels (id, tenant_id, name) values (?, :tenant, ?)", ["l1", "VIP"]),
    MissingTenantScopeError,
  );
  await assert.rejects(
    () =>
      tenantA.run("insert or replace into labels (id, tenant_id, name) values (?, :tenant, ?)", ["l1", "VIP"]),
    MissingTenantScopeError,
  );
  assert.deepEqual(db.prepare("select id from labels").all(), [], "拒否された replace で行が作られていない");
});

test("issue #25 🟡G-3: CTE 前置の insert は静的判定できないため拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run(
        "with s as (select id, email from readers where tenant_id = :tenant) " +
          "insert into labels (tenant_id, id, name) select ?, id, email from s",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );

  // 列位置が正しくても、CTE 前置である限り拒否して呼び出し側に書き直させる。
  await assert.rejects(
    () =>
      tenantA.run(
        "with s as (select id, email from readers where tenant_id = :tenant) " +
          "insert into labels (tenant_id, id, name) select :tenant, id, email from s",
      ),
    MissingTenantScopeError,
  );

  // 素の insert だけでなく insert 変種・replace も同じく拒否する。
  // ここを固定しないと、CTE 判定が持つ insert 変種の列挙が縮んでも誰も気付かない
  // （issue #25 レビュー 🟡-1: 初版のテストはこの2形を流しておらず空振りしていた）。
  await assert.rejects(
    () =>
      tenantA.run(
        "with s as (select id, email from readers where tenant_id = :tenant) " +
          "insert or ignore into labels (tenant_id, id, name) select ?, id, email from s",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );
  await assert.rejects(
    () =>
      tenantA.run(
        "with s as (select id, email from readers where tenant_id = :tenant) " +
          "replace into labels (tenant_id, id, name) select ?, id, email from s",
        ["evil-tenant"],
      ),
    MissingTenantScopeError,
  );
  assert.deepEqual(db.prepare("select id from labels").all(), [], "拒否された CTE insert で行が作られていない");
});

test("issue #25 レビュー 🟡-2: CTE 前置の update / delete も拒否される（マーカーが CTE 側にだけある形）", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");
  db.prepare("insert into labels (id, tenant_id, name) values (?, ?, ?)").run("l1", "tenant-a", "A");
  db.prepare("insert into labels (id, tenant_id, name) values (?, ?, ?)").run("l2", "tenant-b", "B");

  // tenant_id = :tenant のマーカーは CTE 側にしか無く、本体の delete / update は無絞り。
  // 通してしまうと全テナントの labels が消える / 書き換わる。
  await assert.rejects(
    () =>
      tenantA.run("with s as (select id from readers where tenant_id = :tenant) delete from labels"),
    MissingTenantScopeError,
  );
  await assert.rejects(
    () =>
      tenantA.run(
        "with s as (select id from readers where tenant_id = :tenant) update labels set name = ?",
        ["pwned"],
      ),
    MissingTenantScopeError,
  );
  const rows = (
    db.prepare("select id, tenant_id, name from labels order by id").all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row }));
  assert.deepEqual(
    rows,
    [
      { id: "l1", tenant_id: "tenant-a", name: "A" },
      { id: "l2", tenant_id: "tenant-b", name: "B" },
    ],
    "拒否された CTE update / delete で行が消えても書き換わってもいない",
  );

  // 過剰拒否になっていないこと: CTE 前置でも読み取り (select) は通る。
  const read = await tenantA.all<{ id: string }>(
    "with s as (select id from readers where tenant_id = :tenant) select id from s order by id",
  );
  assert.deepEqual(read, [{ id: "r1" }]);
});

test("issue #25 🟢H: 行値代入 set (tenant_id, ...) = (...) も付け替え拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run("update readers set (tenant_id, email) = (?, ?) where tenant_id = :tenant", [
        "evil-tenant",
        "evil@example.com",
      ]),
    TenantReassignmentError,
  );
  // `set(` と空白を置かない書き方でもすり抜けない。
  await assert.rejects(
    () =>
      tenantA.run("update readers set(email,tenant_id)=(?,?) where tenant_id = :tenant", [
        "evil@example.com",
        "evil-tenant",
      ]),
    TenantReassignmentError,
  );
  const untouched = db.prepare("select tenant_id, email from readers where id = ?").get("r1") as {
    tenant_id: string;
    email: string;
  };
  assert.equal(untouched.tenant_id, "tenant-a", "行が別テナントへ付け替えられた");
  assert.equal(untouched.email, "a@example.com", "行値代入が実行されてしまった");

  // tenant_id を含まない行値代入は従来どおり通ること（過剰拒否になっていない）。
  await tenantA.run("update readers set (email, id) = (?, ?) where tenant_id = :tenant", [
    "new@example.com",
    "r1",
  ]);
  const updated = db.prepare("select email from readers where id = ?").get("r1") as { email: string };
  assert.equal(updated.email, "new@example.com");
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

test('PR #22 再レビュー 🟡B-1: update set "tenant_id" = ... のような引用識別子も付け替え拒否される', async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run('update readers set "tenant_id" = ? where tenant_id = :tenant and id = ?', [
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

test("PR #22 再レビュー 🟡B-2: upsert の on conflict do update set tenant_id も付け替え拒否される", async () => {
  const { db, executor } = createExecutor();
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () =>
      tenantA.run(
        "insert into readers (id, tenant_id, email) values (?, :tenant, ?) on conflict(id) do update set tenant_id = ?",
        ["r1", "z@example.com", "evil-tenant"],
      ),
    TenantReassignmentError,
  );
  const untouched = db.prepare("select tenant_id, email from readers where id = ?").get("r1") as {
    tenant_id: string;
    email: string;
  };
  assert.equal(untouched.tenant_id, "tenant-a", "行が別テナントへ付け替えられた");
  assert.equal(untouched.email, "a@example.com", "upsert の再代入が実行されてしまった");
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
  //
  // PR #22 再レビュー 🟢D: 1ファイル（初期スキーマ）だけしか見ていないと、
  // 以後の migration で tenant_id 付きテーブルが追加されても漏れ検出が効かない。
  // supabase/migrations/ 配下の全 .sql から create table ブロックを集める。
  const { readFile, readdir } = await import("node:fs/promises");
  const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort();
  assert.ok(sqlFiles.length > 0, "migration ファイルが1件も見つからない");

  const tenantScopedInSchema: string[] = [];
  const tableBlockPattern = /create table public\.(\w+) \(([\s\S]*?)\n\);/g;
  for (const file of sqlFiles) {
    const sql = await readFile(new URL(file, migrationsDir), "utf8");
    for (const match of sql.matchAll(tableBlockPattern)) {
      const [, tableName, body] = match;
      if (/\btenant_id\b/.test(body) && !tenantScopedInSchema.includes(tableName)) {
        tenantScopedInSchema.push(tableName);
      }
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
