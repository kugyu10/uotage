// issue #29 [移行 P5]: workers/tenant-do/src/index.ts の TenantDurableObject.registerReader
// から Cloudflare型非依存部分を切り出した src/lib/d1/register-reader-rpc.ts のテスト。
// process-stripe-purchase-rpc.test.ts と同じ理由・同じ構造（そちらのヘッダコメント参照）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { runRegisterReaderRpc } from "../../src/lib/d1/register-reader-rpc.ts";
import type { RegisterReaderInput } from "../../src/lib/readers/register-reader.ts";

const SCHEMA =
  readFileSync(new URL("../../cloudflare/d1/migrations/0001_deliveries.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0002_process_stripe_purchase_tables.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0003_register_reader_tables.sql", import.meta.url), "utf8");

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

function seedFunnel(db: DatabaseSync, tenantId: string, funnelId: string, slug: string) {
  db.prepare(
    "insert into funnels (id, tenant_id, name, slug, trigger_type, deadline_hours, is_active, created_at) values (?, ?, ?, ?, 'registration', 72, 1, ?)",
  ).run(funnelId, tenantId, "funnel", slug, "2026-09-01T00:00:00.000Z");
  const scenarioId = `${funnelId}-scenario`;
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, 1, ?)",
  ).run(scenarioId, tenantId, "da-1", funnelId, "scenario", "2026-09-01T00:00:00.000Z");
  db.prepare(
    "insert into step_messages (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at) values (?, ?, ?, 0, 0, null, 's', 'b', ?)",
  ).run(`${funnelId}-step`, tenantId, scenarioId, "2026-09-01T00:00:00.000Z");
}

function baseInput(overrides: Partial<RegisterReaderInput> = {}): RegisterReaderInput {
  return {
    funnelSlug: "funnel-a",
    email: "reader@example.com",
    name: "Reader",
    registrationPath: null,
    accessToken: "access-1",
    unsubscribeToken: "unsub-1",
    now: "2026-09-14T03:00:00.000Z",
    ...overrides,
  };
}

test("runRegisterReaderRpc: doName から解決したテナントIDだけに書き込む（配線の検証）", async () => {
  const { db, executor } = createDb();
  seedFunnel(db, "tenant-a", "funnel-1-a", "funnel-a");
  seedFunnel(db, "tenant-b", "funnel-1-b", "funnel-a");

  const result = await runRegisterReaderRpc(executor, "tenant-a", baseInput());

  assert.equal(result.ok, true);
  assert.equal(result.result?.subject, "s");
  const readersA = db.prepare("select * from readers where tenant_id = 'tenant-a'").all();
  assert.equal(readersA.length, 1, "doName=tenant-a のときは tenant-a にだけ書き込む");
  const readersB = db.prepare("select * from readers where tenant_id = 'tenant-b'").all();
  assert.equal(readersB.length, 0, "tenant-b には何も書き込まれない（もし固定文字列に差し替えられていたらここで検出できる）");
});

test("runRegisterReaderRpc: doName が null なら DB に触れずに ok:false を返す", async () => {
  const { db, executor } = createDb();

  const result = await runRegisterReaderRpc(executor, null, baseInput());

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /idFromName\(tenantId\)/);
  const readerCount = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(readerCount.c, 0);
});

test("runRegisterReaderRpc: 業務ロジックの例外は投げずに ok:false + errorName で返す", async () => {
  const { executor } = createDb();
  // funnel を作らずに呼ぶ → ActiveRegistrationFunnelNotFoundError。

  const result = await runRegisterReaderRpc(executor, "tenant-a", baseInput());

  assert.equal(result.ok, false);
  assert.equal(result.errorName, "ActiveRegistrationFunnelNotFoundError");
  assert.equal(result.result, undefined);
});
