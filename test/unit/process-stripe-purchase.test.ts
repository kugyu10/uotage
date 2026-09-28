// issue #29 [移行 P5]: process_stripe_purchase (supabase/migrations/20260815020000) の
// TS移植 (src/lib/purchases/process-stripe-purchase.ts) のテスト。
// node:sqlite に本物のスキーマ (cloudflare/d1/migrations/0001, 0002) を適用し、
// createTenantDb 越しに実行して Postgres 版と同じ結果になることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createTenantDb, type D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { D1_MAX_BIND_PARAMS } from "../../src/lib/delivery-queue/claim.ts";
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
    /** funnels.product_id に入れる値。省略時は opts.productId（レビュー 🟡-3 用に分離）。 */
    funnelProductId?: string;
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
      opts.funnelProductId ?? opts.productId,
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
  assert.equal(enrollment.registered_at, "2026-09-14T03:00:00.000Z", "新規登録時は purchasedAt がそのまま registered_at になる（レビュー 🟡-5）");
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

// --- レビュー 🟡-1〜🟡-6 の空振り解消。既存アサーションを本体を壊さず通しただけでは
// 検出できなかった経路を、逐次テストで踏めるケースに置き換えている（29-review-1.md 参照）。

test("冪等性: 2回目の呼び出しは purchases の select 1本で終わる（alreadyProcessed ガード単独の固定。レビュー 🟡-1-2）", async () => {
  const { db, executor: baseExecutor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });

  const calls: Array<{ sql: string; params: readonly (string | number | null)[] }> = [];
  const executor: D1Executor = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
      calls.push({ sql, params });
      return baseExecutor.all<T>(sql, params);
    },
    run(sql: string, params: readonly (string | number | null)[]) {
      calls.push({ sql, params });
      return baseExecutor.run(sql, params);
    },
  };
  const tenantA = createTenantDb(executor, "tenant-a");

  await processStripePurchase(tenantA, baseInput());
  calls.length = 0;
  await processStripePurchase(tenantA, baseInput());

  // alreadyProcessed ガードが効いていれば、2回目は「purchases を1件selectして即return」で
  // 終わるはず。ガードを消すと product/scenario/funnel/steps の select と reader/purchase の
  // insert まで進み、呼び出し回数が明確に増える（実測: ガード有効時1回、無効時6回）。
  assert.equal(calls.length, 1, "2回目は select 1本で終わるはず（alreadyProcessed で早期return）");
  // tenant-db.ts の bindTenant() が :tenant マーカーを ? に置換してから executor に渡すため、
  // 実際に届く SQL では :tenant ではなく ? になっている。
  assert.match(calls[0].sql, /select id from purchases where tenant_id = \? and stripe_session_id = \?/);
});

test("越境: 他テナントに同じ stripe_session_id の purchases 行があると、reader だけ作られてそれ以降は書き込まれない（!purchase ガード単独の固定。レビュー 🟡-1-1 / 🟡-4）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    postPurchaseLabelId: "label-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  seedTenant(db, { tenantId: "tenant-b", productId: "prod-1-b" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-b", "tenant-b", "other@example.com", null, "access-b", "unsub-b", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, amount, purchased_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("purchase-b", "tenant-b", "reader-b", "prod-1-b", "sess-1", 500, "2026-01-01T00:00:00.000Z");

  const tenantA = createTenantDb(executor, "tenant-a");
  await processStripePurchase(tenantA, baseInput({ stripeSessionId: "sess-1" }));

  // 事前チェックは tenant_id = :tenant で絞るため tenant-b の行は見えず、1つ目のガードは素通りする。
  const readerCount = db.prepare("select count(*) as c from readers where tenant_id = 'tenant-a'").get() as {
    c: number;
  };
  assert.equal(readerCount.c, 1, "reader upsert は素通りする（1つ目のガードは無関係）");
  // purchases はグローバル UNIQUE (stripe_session_id) で conflict → do nothing → returning が空
  // → if (!purchase) return がここで単独で効く。
  const purchaseCount = db.prepare("select count(*) as c from purchases where tenant_id = 'tenant-a'").get() as {
    c: number;
  };
  assert.equal(purchaseCount.c, 0, "tenant-a の purchases は作られない");
  const labelCount = db.prepare("select count(*) as c from reader_labels").get() as { c: number };
  assert.equal(labelCount.c, 0, "if (!purchase) return が効いていれば reader_labels には進まない");
  const enrollmentCount = db.prepare("select count(*) as c from scenario_readers").get() as { c: number };
  assert.equal(enrollmentCount.c, 0, "if (!purchase) return が効いていれば scenario_readers には進まない");
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 0, "if (!purchase) return が効いていれば deliveries には進まない");
});

test("scenarios が is_active=0 だと post-purchase scenario not found になる（レビュー 🟡-2）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    scenarioActive: false,
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), PostPurchaseScenarioNotFoundError);
});

test("funnels が is_active=0 だと active purchase funnel not found になる（レビュー 🟡-2）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    funnelActive: false,
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), ActivePurchaseFunnelNotFoundError);
});

test("funnels.product_id が別商品だと active purchase funnel not found になる（レビュー 🟡-3）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    funnelProductId: "prod-other",
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => processStripePurchase(tenantA, baseInput()), ActivePurchaseFunnelNotFoundError);
});

test("既に同シナリオへ登録済みの読者が別セッションで再度この経路を通ると、配信予定時刻は既存の registered_at を基準にする（レビュー 🟡-6 / 🟡-4）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    deadlineHours: 48,
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  // 1回目: 2026-08-01 に登録。
  await processStripePurchase(tenantA, baseInput({ stripeSessionId: "sess-old", purchasedAt: "2026-08-01T00:00:00.000Z" }));

  const reader = db.prepare("select * from readers where tenant_id = 'tenant-a'").get() as Record<string, unknown>;
  const enrollmentBefore = db
    .prepare("select * from scenario_readers where reader_id = ?")
    .get(reader.id as string) as Record<string, unknown>;
  assert.equal(enrollmentBefore.registered_at, "2026-08-01T00:00:00.000Z");

  // 2回目: 別の stripe_session_id で同じ商品を購入（同一 reader・同一 scenario への再エンロール）。
  // on conflict (reader_id, scenario_id) do update set reader_id = excluded.reader_id は
  // registered_at を更新しないため、Postgres版と同様「元の registered_at」が基準であるべき。
  await processStripePurchase(
    tenantA,
    baseInput({ stripeSessionId: "sess-new", purchasedAt: "2026-09-14T03:00:00.000Z" }),
  );

  const enrollmentAfter = db
    .prepare("select * from scenario_readers where reader_id = ?")
    .get(reader.id as string) as Record<string, unknown>;
  assert.equal(
    enrollmentAfter.registered_at,
    "2026-08-01T00:00:00.000Z",
    "on conflict do update は registered_at を更新しない",
  );
  assert.equal(enrollmentAfter.id, enrollmentBefore.id, "同じ scenario_readers 行が更新される（新規行ではない）");

  // deliveries 側: 同じ (scenario_reader_id, step_message_id) への2回目の insert は
  // on conflict do nothing が無いと SQLite の UNIQUE 制約違反で例外になる（=このテスト自体が失敗する）。
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 1, "on conflict do nothing で2回目は増えない");
  const delivery = db
    .prepare("select * from deliveries where scenario_reader_id = ?")
    .get(enrollmentAfter.id as string) as Record<string, unknown>;
  assert.equal(
    delivery.scheduled_at,
    "2026-08-01T00:00:00.000Z",
    "配信予定時刻は既存の registered_at 基準（2回目の purchasedAt ではない）",
  );
});

test("21ステップ以上のシナリオでも deliveries insert が D1 のバインドパラメータ上限を超えない（チャンク化。レビュー 🔴-2）", async () => {
  const { db, executor } = createDb();
  const stepMessages = Array.from({ length: 21 }, (_, i) => ({
    id: `step-${i}`,
    delayMinutes: i,
    sendAtHour: null as number | null,
  }));
  seedTenant(db, {
    tenantId: "tenant-a",
    productId: "prod-1",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    stepMessages,
  });

  const deliveryInsertCalls: Array<{ params: readonly (string | number | null)[] }> = [];
  const recordingExecutor: D1Executor = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
      return executor.all<T>(sql, params);
    },
    run(sql: string, params: readonly (string | number | null)[]) {
      if (/insert into deliveries/.test(sql)) deliveryInsertCalls.push({ params });
      return executor.run(sql, params);
    },
  };
  const tenantA = createTenantDb(recordingExecutor, "tenant-a");

  await processStripePurchase(tenantA, baseInput());

  assert.ok(
    deliveryInsertCalls.length >= 2,
    `21ステップ(1ステップ5パラメータ=105個)は1回のinsertには収まらずチャンク分割されるはず: ${deliveryInsertCalls.length}回`,
  );
  for (const call of deliveryInsertCalls) {
    assert.ok(
      call.params.length <= D1_MAX_BIND_PARAMS,
      `1回の insert deliveries のパラメータ数が D1 の上限を超えている: ${call.params.length}`,
    );
  }
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 21, "全ステップぶんの配信予定が作られる（チャンク分割しても欠落しない）");
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
