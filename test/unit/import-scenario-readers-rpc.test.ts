// issue #29 [移行 P5]: workers/tenant-do/src/index.ts の
// TenantDurableObject.importScenarioReaders から Cloudflare型非依存部分を切り出した
// src/lib/d1/import-scenario-readers-rpc.ts のテスト。
// register-reader-rpc.test.ts / process-stripe-purchase-rpc.test.ts と同じ理由・同じ構造
// （そちらのヘッダコメント参照）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { runImportScenarioReadersRpc } from "../../src/lib/d1/import-scenario-readers-rpc.ts";
import type { ImportScenarioReadersInput } from "../../src/lib/readers/import-scenario-readers.ts";

const SCHEMA =
  readFileSync(new URL("../../cloudflare/d1/migrations/0001_deliveries.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0002_process_stripe_purchase_tables.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0003_register_reader_tables.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0004_import_scenario_readers_tables.sql", import.meta.url), "utf8");

function createDb(): { db: DatabaseSync; executor: D1Executor } {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const executor: D1Executor = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
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

function seedScenario(db: DatabaseSync, tenantId: string, scenarioId: string) {
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, null, ?, 1, ?)",
  ).run(scenarioId, tenantId, "da-1", "scenario", "2026-09-01T00:00:00.000Z");
}

function baseInput(overrides: Partial<ImportScenarioReadersInput> = {}): ImportScenarioReadersInput {
  return {
    scenarioId: "scenario-1",
    deliveryMode: "none",
    registeredAt: null,
    executedAt: "2026-09-14T03:00:00.000Z",
    rows: [
      {
        email: "reader@example.com",
        name: "Reader",
        registrationPath: null,
        labels: [],
        customFields: {},
        accessToken: "access-1",
        unsubscribeToken: "unsub-1",
        unsubscribed: false,
      },
    ],
    ...overrides,
  };
}

test("runImportScenarioReadersRpc: doName から解決したテナントIDだけに書き込む（配線の検証）", async () => {
  const { db, executor } = createDb();
  seedScenario(db, "tenant-a", "scenario-1-a");
  seedScenario(db, "tenant-b", "scenario-1-b");

  const result = await runImportScenarioReadersRpc(executor, "tenant-a", baseInput({ scenarioId: "scenario-1-a" }));

  assert.equal(result.ok, true);
  assert.equal(result.result?.createdReaders, 1);
  const readersA = db.prepare("select * from readers where tenant_id = 'tenant-a'").all();
  assert.equal(readersA.length, 1, "doName=tenant-a のときは tenant-a にだけ書き込む");
  const readersB = db.prepare("select * from readers where tenant_id = 'tenant-b'").all();
  assert.equal(readersB.length, 0, "tenant-b には何も書き込まれない(もし固定文字列に差し替えられていたらここで検出できる)");
});

test("runImportScenarioReadersRpc: doName が null なら DB に触れずに ok:false を返す", async () => {
  const { db, executor } = createDb();

  const result = await runImportScenarioReadersRpc(executor, null, baseInput());

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /idFromName\(tenantId\)/);
  const readerCount = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(readerCount.c, 0);
});

test("runImportScenarioReadersRpc: 業務ロジックの例外は投げずに ok:false + errorName で返す", async () => {
  const { executor } = createDb();
  // scenario を作らずに呼ぶ → ImportScenarioNotFoundError。

  const result = await runImportScenarioReadersRpc(executor, "tenant-a", baseInput());

  assert.equal(result.ok, false);
  assert.equal(result.errorName, "ImportScenarioNotFoundError");
  assert.equal(result.result, undefined);
});

test("runImportScenarioReadersRpc: 行数超過も例外を投げずに errorName で返す", async () => {
  const { db, executor } = createDb();
  seedScenario(db, "tenant-a", "scenario-1");
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    email: `reader-${i}@example.com`,
    name: null,
    registrationPath: null,
    labels: [],
    customFields: {},
    accessToken: `access-${i}`,
    unsubscribeToken: `unsub-${i}`,
    unsubscribed: false,
  }));

  const result = await runImportScenarioReadersRpc(executor, "tenant-a", baseInput({ rows }));

  assert.equal(result.ok, false);
  assert.equal(result.errorName, "TooManyImportRowsError");
});
