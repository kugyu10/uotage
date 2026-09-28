// issue #29 [移行 P5]: process_stripe_purchase (supabase/migrations/20260815020000) の
// TS移植 (src/lib/purchases/process-stripe-purchase.ts) のテスト。
// node:sqlite に本物のスキーマ (cloudflare/d1/migrations/0001, 0002) を適用し、
// createTenantDb 越しに実行して Postgres 版と同じ結果になることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createTenantDb, type D1Executor } from "../../src/lib/d1/tenant-db.ts";
import {
  ActivePurchaseFunnelNotFoundError,
  computeStepScheduledAt,
  PostPurchaseScenarioNotFoundError,
  ProductNotFoundError,
  processStripePurchase,
  type ProcessStripePurchaseInput,
} from "../../src/lib/purchases/process-stripe-purchase.ts";

const SCHEMA =
  readFileSync(new URL("../../cloudflare/d1/migrations/0001_deliveries.sql", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../cloudflare/d1/migrations/0002_process_stripe_purchase_tables.sql", import.meta.url), "utf8");

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

/** テナント1件ぶんの商品/シナリオ/ファネル/ステップを作る最小フィクスチャ。 */
function seedTenant(
  db: DatabaseSync,
  opts: {
    tenantId: string;
    productId: string;
    scenarioId?: string;
    funnelId?: string;
    postPurchaseLabelId?: string | null;
    postPurchaseScenarioId?: string | null;
    stepMessages?: Array<{ id: string; delayMinutes: number; sendAtHour: number | null }>;
    funnelActive?: boolean;
    scenarioActive?: boolean;
    deadlineHours?: number;
  },
) {
  const now = "2026-09-01T00:00:00.000Z";
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, post_purchase_scenario_id, post_purchase_label_id, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.productId,
    opts.tenantId,
    "product",
    "price_x",
    opts.postPurchaseScenarioId ?? opts.scenarioId ?? null,
    opts.postPurchaseLabelId ?? null,
    now,
  );

  if (opts.scenarioId) {
    db.prepare(
      "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(opts.scenarioId, opts.tenantId, "da-1", opts.funnelId ?? null, "scenario", opts.scenarioActive === false ? 0 : 1, now);
  }
  if (opts.funnelId) {
    db.prepare(
      "insert into funnels (id, tenant_id, name, slug, trigger_type, product_id, deadline_hours, is_active, created_at) values (?, ?, ?, ?, 'purchase', ?, ?, ?, ?)",
    ).run(
      opts.funnelId,
      opts.tenantId,
      "funnel",
      `${opts.tenantId}-${opts.funnelId}`,
      opts.productId,
      opts.deadlineHours ?? 72,
      opts.funnelActive === false ? 0 : 1,
      now,
    );
  }
  for (const step of opts.stepMessages ?? []) {
    db.prepare(
      "insert into step_messages (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at) values (?, ?, ?, 0, ?, ?, 's', 'b', ?)",
    ).run(step.id, opts.tenantId, opts.scenarioId ?? null, step.delayMinutes, step.sendAtHour, now);
  }
}

function baseInput(overrides: Partial<ProcessStripePurchaseInput> = {}): ProcessStripePurchaseInput {
  return {
    productId: "prod-1",
    stripeSessionId: "sess-1",
    buyerEmail: "Buyer@Example.com",
    buyerName: "Buyer",
    paidAmount: 1000,
    purchasedAt: "2026-09-14T03:00:00.000Z",
    accessToken: "access-1",
    unsubscribeToken: "unsub-1",
    ...overrides,
  };
}

test("最小ケース: シナリオ無し商品の購入で reader と purchase だけ作る", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", productId: "prod-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await processStripePurchase(tenantA, baseInput());

  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  assert.equal(reader.email, "buyer@example.com", "メールは小文字化される");
  assert.equal(reader.name, "Buyer");
  assert.equal(reader.access_token, "access-1");

  const purchase = db.prepare("select * from purchases where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  assert.equal(purchase.stripe_session_id, "sess-1");
  assert.equal(purchase.reader_id, reader.id);

  const enrollments = db.prepare("select count(*) as c from scenario_readers").get() as { c: number };
  assert.equal(enrollments.c, 0, "post_purchase_scenario_id が無ければシナリオ登録しない");
});

test("フル経路: ラベル付与・シナリオ登録・配信キュー投入まで行う", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    postPurchaseLabelId: "label-1",
    deadlineHours: 48,
    stepMessages: [
      { id: "step-1", delayMinutes: 0, sendAtHour: null },
      { id: "step-2", delayMinutes: 60, sendAtHour: 9 },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await processStripePurchase(tenantA, baseInput());

  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  const label = db.prepare("select * from reader_labels where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(label.label_id, "label-1");

  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.scenario_id, "scenario-1");
  assert.equal(enrollment.registration_path, "stripe");
  assert.equal(enrollment.deadline_at, "2026-09-16T03:00:00.000Z", "purchasedAt + 48h");

  const deliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ? order by step_message_id")
    .all(enrollment.id as string) as Array<Record<string, unknown>>;
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].scheduled_at, "2026-09-14T03:00:00.000Z", "send_at_hour null は delay_minutes だけ加算");
  // purchasedAt(03:00Z) + 60min = 04:00Z = JST 2026-09-14 13:00。同日のJST日付のまま
  // send_at_hour=9(JST)に丸める → JST 2026-09-14 09:00 → UTC 2026-09-14T00:00:00Z。
  assert.equal(deliveries[1].scheduled_at, "2026-09-14T00:00:00.000Z");
});

test("冪等性: 同じ stripe_session_id を2回処理しても重複しない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await processStripePurchase(tenantA, baseInput());
  await processStripePurchase(tenantA, baseInput());

  const purchaseCount = db.prepare("select count(*) as c from purchases").get() as { c: number };
  assert.equal(purchaseCount.c, 1);
  const readerCount = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(readerCount.c, 1);
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 1);
});

test("既存 reader は名前が無い時だけ埋める。トークンは上書きしない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", productId: "prod-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "buyer@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  await processStripePurchase(tenantA, baseInput({ buyerName: "New Name" }));

  const reader = db.prepare("select * from readers where id = ?").get("reader-existing") as Record<string, unknown>;
  assert.equal(reader.name, "New Name", "既存 name が null のときは埋める");
  assert.equal(reader.access_token, "old-access", "既存トークンは上書きしない");

  // 2回目: 既に name がある状態で別の名前が来ても上書きしない。
  await processStripePurchase(
    tenantA,
    baseInput({ stripeSessionId: "sess-2", buyerName: "Another Name" }),
  );
  const reader2 = db.prepare("select * from readers where id = ?").get("reader-existing") as Record<string, unknown>;
  assert.equal(reader2.name, "New Name", "既存 name がある時は上書きしない（coalesce）");
});

test("product not found は例外を投げ、何も書き込まない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", productId: "prod-other" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), ProductNotFoundError);

  const readerCount = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(readerCount.c, 0, "product not found の前に書き込みは発生しない");
});

test("post-purchase scenario not found / active purchase funnel not found でも部分書き込みが残らない", async () => {
  const { db, executor } = createDb();
  // シナリオが存在しない (post_purchase_scenario_id が指す行が無い)。
  seedTenant(db, { tenantId: "tenant-a", productId: "prod-1", postPurchaseScenarioId: "missing-scenario" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), PostPurchaseScenarioNotFoundError);
  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 0);
  assert.equal((db.prepare("select count(*) as c from purchases").get() as { c: number }).c, 0);

  // シナリオはあるが、対応する active な purchase funnel が無い。
  const { db: db2, executor: executor2 } = createDb();
  seedTenant(db2, { tenantId: "tenant-a", productId: "prod-1", scenarioId: "scenario-1" });
  const tenantA2 = createTenantDb(executor2, "tenant-a");
  await assert.rejects(() => processStripePurchase(tenantA2, baseInput()), ActivePurchaseFunnelNotFoundError);
  assert.equal((db2.prepare("select count(*) as c from readers").get() as { c: number }).c, 0);
  assert.equal((db2.prepare("select count(*) as c from purchases").get() as { c: number }).c, 0);
});

test("テナント越境: 他テナントの productId を指定しても見つからず、何も書き込まれない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-b", productId: "prod-1" });
  // tenant-a には同名IDの商品を作らない → tenant-a として処理すると必ず product not found になる。
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), ProductNotFoundError);

  const tenantBReaders = db.prepare("select count(*) as c from readers where tenant_id = 'tenant-b'").get() as {
    c: number;
  };
  assert.equal(tenantBReaders.c, 0, "tenant-b 側にも何も書き込まれていない");
  const anyReaders = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(anyReaders.c, 0);
});

test("テナント越境: 同じ email でも別テナントには別 reader が作られ、互いに見えない", async () => {
  const { db, executor } = createDb();
  // products.id はテナント単位ではなくグローバルな主キー（Postgres 版の uuid PK と同じ）
  // なので、2テナント分のフィクスチャを同じ id では作れない。テナントごとに別 id にする。
  seedTenant(db, { tenantId: "tenant-a", productId: "prod-1-a" });
  seedTenant(db, { tenantId: "tenant-b", productId: "prod-1-b" });
  const tenantA = createTenantDb(executor, "tenant-a");
  const tenantB = createTenantDb(executor, "tenant-b");

  // access_token / unsubscribe_token は readers テーブル全体でグローバルに一意（Postgres 版と同じ）。
  // 実運用では createUrlToken() が呼び出しごとに新しい乱数を生成するため衝突しない。
  await processStripePurchase(
    tenantA,
    baseInput({ productId: "prod-1-a", stripeSessionId: "sess-a", accessToken: "access-a", unsubscribeToken: "unsub-a" }),
  );
  await processStripePurchase(
    tenantB,
    baseInput({ productId: "prod-1-b", stripeSessionId: "sess-b", accessToken: "access-b", unsubscribeToken: "unsub-b" }),
  );

  const readers = db.prepare("select tenant_id, email from readers order by tenant_id").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(readers.length, 2, "同じメールでもテナントごとに別行になる");
  assert.deepEqual(
    readers.map((r) => r.tenant_id),
    ["tenant-a", "tenant-b"],
  );

  const purchasesA = await tenantA.all<{ id: string }>("select id from purchases where tenant_id = :tenant");
  assert.equal(purchasesA.length, 1, "tenant-a からは自分の purchase しか見えない");
});

test("computeStepScheduledAt: send_at_hour が無い場合は delay_minutes をそのまま加算する", () => {
  const scheduled = computeStepScheduledAt("2026-09-14T03:00:00.000Z", 90, null);
  assert.equal(scheduled, "2026-09-14T04:30:00.000Z");
});

test("computeStepScheduledAt: send_at_hour ありは JST の日付境界で丸める（日をまたぐケース）", () => {
  // 2026-09-14T20:00:00Z = JST 2026-09-15 05:00。delay 0分、send_at_hour=9 (JST) を指定すると
  // JST 2026-09-15 09:00 → UTC 2026-09-15T00:00:00Z になる（日付が進む）。
  const scheduled = computeStepScheduledAt("2026-09-14T20:00:00.000Z", 0, 9);
  assert.equal(scheduled, "2026-09-15T00:00:00.000Z");
});
