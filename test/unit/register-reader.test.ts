// issue #29 [移行 P5]: register_reader (supabase/migrations/20260902020000 が最終版) の
// TS移植 (src/lib/readers/register-reader.ts) のテスト。
// node:sqlite に本物のスキーマ (cloudflare/d1/migrations/0001, 0002, 0003) を適用し、
// createTenantDb 越しに実行して Postgres 版と同じ結果になることを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createTenantDb, type D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { D1_MAX_BIND_PARAMS } from "../../src/lib/delivery-queue/claim.ts";
import {
  ActiveRegistrationFunnelNotFoundError,
  ActiveScenarioNotFoundError,
  RegistrationPathNotFoundError,
  registerReader,
  type RegisterReaderInput,
} from "../../src/lib/readers/register-reader.ts";

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

const NOW = "2026-09-01T00:00:00.000Z";

/** テナント1件ぶんのファネル/シナリオ/ステップを作る最小フィクスチャ。 */
function seedTenant(
  db: DatabaseSync,
  opts: {
    tenantId: string;
    funnelId: string;
    funnelSlug: string;
    scenarioId?: string;
    funnelProductId?: string | null;
    funnelActive?: boolean;
    scenarioActive?: boolean;
    deadlineHours?: number;
    funnelTriggerType?: string;
    stepMessages?: Array<{
      id: string;
      position: number;
      delayMinutes: number;
      sendAtHour: number | null;
      subject?: string;
      body?: string;
      skipIfPurchased?: boolean;
      grantLabelId?: string | null;
    }>;
  },
) {
  db.prepare(
    "insert into funnels (id, tenant_id, name, slug, trigger_type, product_id, deadline_hours, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.funnelId,
    opts.tenantId,
    "funnel",
    opts.funnelSlug,
    opts.funnelTriggerType ?? "registration",
    opts.funnelProductId ?? null,
    opts.deadlineHours ?? 72,
    opts.funnelActive === false ? 0 : 1,
    NOW,
  );
  if (opts.scenarioId) {
    db.prepare(
      "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(opts.scenarioId, opts.tenantId, "da-1", opts.funnelId, "scenario", opts.scenarioActive === false ? 0 : 1, NOW);
  }
  for (const step of opts.stepMessages ?? []) {
    db.prepare(
      `insert into step_messages
        (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, skip_if_purchased, grant_label_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      step.id,
      opts.tenantId,
      opts.scenarioId ?? null,
      step.position,
      step.delayMinutes,
      step.sendAtHour,
      step.subject ?? "件名",
      step.body ?? "本文",
      step.skipIfPurchased ? 1 : 0,
      step.grantLabelId ?? null,
      NOW,
    );
  }
}

function seedRegistrationPath(
  db: DatabaseSync,
  opts: { tenantId: string; funnelId: string; path: string; labelId?: string | null },
) {
  db.prepare(
    "insert into registration_paths (id, tenant_id, funnel_id, path, name, label_id, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(`rp-${opts.path}`, opts.tenantId, opts.funnelId, opts.path, opts.path, opts.labelId ?? null, NOW);
}

function baseInput(overrides: Partial<RegisterReaderInput> = {}): RegisterReaderInput {
  return {
    funnelSlug: "funnel-a",
    email: "Reader@Example.com",
    name: "Reader",
    registrationPath: null,
    accessToken: "access-1",
    unsubscribeToken: "unsub-1",
    now: "2026-09-14T03:00:00.000Z",
    ...overrides,
  };
}

test("最小ケース: 1ステップのシナリオへ新規登録し、1通目が processing でキューに積まれ即時送信の材料が返る", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    deadlineHours: 48,
    stepMessages: [
      { id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null, subject: "1通目", body: "本文1", grantLabelId: "grant-1" },
      { id: "step-2", position: 1, delayMinutes: 60, sendAtHour: 9 },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  assert.equal(reader.email, "reader@example.com", "メールは trim + 小文字化される");
  assert.equal(reader.name, "Reader");
  assert.equal(reader.access_token, "access-1");
  assert.equal(reader.created_at, "2026-09-14T03:00:00.000Z");

  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.registered_at, "2026-09-14T03:00:00.000Z");
  assert.equal(enrollment.deadline_at, "2026-09-16T03:00:00.000Z", "purchasedAt + 48h");
  assert.equal(enrollment.registration_path, null);

  const deliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ? order by step_message_id")
    .all(enrollment.id as string) as Array<Record<string, unknown>>;
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].status, "processing", "1通目は即時送信前提の processing");
  assert.equal(deliveries[0].error_message, null);
  assert.equal(deliveries[1].status, "queued", "2通目以降は queued");

  assert.equal(result.email, "reader@example.com");
  assert.equal(result.funnelSlug, "funnel-a");
  assert.equal(result.deadlineAt, "2026-09-16T03:00:00.000Z");
  assert.equal(result.subject, "1通目");
  assert.equal(result.body, "本文1");
  assert.equal(result.initialDeliveryId, deliveries[0].id);
  assert.equal(result.initialGrantLabelId, "grant-1");
  assert.equal(result.readerId, reader.id);
});

test("registration_path が指定され登録経路にラベルがあれば reader_labels を付与する", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  seedRegistrationPath(db, { tenantId: "tenant-a", funnelId: "funnel-1", path: "line", labelId: "label-line" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await registerReader(tenantA, baseInput({ registrationPath: "line" }));

  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  const label = db.prepare("select * from reader_labels where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(label.label_id, "label-line");

  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.registration_path, "line");

  // レビュー指摘 🟡-5: reader_labels は primary key (reader_id, label_id) のため、
  // on conflict do nothing が落ちると同じ経路での2回目の登録が UNIQUE 制約違反で例外になる。
  // 同じ registrationPath で2回目を呼んでも例外にならず、reader_labels が増えないことを確認する。
  await assert.doesNotReject(() => registerReader(tenantA, baseInput({ registrationPath: "line", now: "2026-09-14T03:05:00.000Z" })));
  const labelCount = db.prepare("select count(*) as c from reader_labels where reader_id = ?").get(
    reader.id as string,
  ) as { c: number };
  assert.equal(labelCount.c, 1, "2回目の登録でも reader_labels は増えない(二重付与防止)");
});

test("registration_path が登録済みだがラベルが無い場合は reader_labels に何も積まない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  seedRegistrationPath(db, { tenantId: "tenant-a", funnelId: "funnel-1", path: "line", labelId: null });
  const tenantA = createTenantDb(executor, "tenant-a");

  await registerReader(tenantA, baseInput({ registrationPath: "line" }));

  const labelCount = db.prepare("select count(*) as c from reader_labels").get() as { c: number };
  assert.equal(labelCount.c, 0);
});

test("registration_path が未登録なら例外を投げ、何も書き込まない（読む・判断するフェーズで確定させる。既知の差分1）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () => registerReader(tenantA, baseInput({ registrationPath: "unknown-path" })),
    RegistrationPathNotFoundError,
  );

  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 0, "reader が作られていない");
  assert.equal(
    (db.prepare("select count(*) as c from scenario_readers").get() as { c: number }).c,
    0,
    "scenario_readers も作られていない（Postgres版は書き込み後に例外だが、TS版は書き込み前に確定させる）",
  );
});

test("active registration funnel not found は例外を投げ、何も書き込まない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "other-funnel" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveRegistrationFunnelNotFoundError);
  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 0);
});

test("funnel が is_active=0 だと active registration funnel not found になる", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a", funnelActive: false });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveRegistrationFunnelNotFoundError);
});

test("funnel.trigger_type が 'purchase' だと active registration funnel not found になる", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a", funnelTriggerType: "purchase" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveRegistrationFunnelNotFoundError);
});

test("active scenario not found（ファネルはあるがシナリオが無い）は例外を投げ、何も書き込まない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveScenarioNotFoundError);
  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 0);
});

test("scenario が is_active=0 だと active scenario not found になる", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    scenarioActive: false,
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveScenarioNotFoundError);
});

test("同一ファネルに複数の active シナリオがあれば created_at, id の昇順で最初の1件を使う", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a" });
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("scenario-later", "tenant-a", "da-1", "funnel-1", "later", 1, "2026-02-01T00:00:00.000Z");
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("scenario-earlier", "tenant-a", "da-1", "funnel-1", "earlier", 1, "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into step_messages (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at) values (?, ?, ?, 0, 0, null, 's', 'b', ?)",
  ).run("step-earlier", "tenant-a", "scenario-earlier", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.scenario_id, "scenario-earlier", "作成日時が先の(=id昇順以前ではなくcreated_at昇順の)シナリオを選ぶ");
  assert.equal(result.subject, "s", "選ばれたシナリオ(scenario-earlier)の1通目(手動insertした 's')が返る");
});

test("既存 reader は名前が無い時だけ埋める。トークンは上書きしない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput({ name: "New Name" }));

  assert.equal(result.name, "New Name", "既存 name が null のときは埋める");
  assert.equal(result.accessToken, "old-access", "既存トークンは上書きしない");
});

test("既存 reader に名前が既にあるときは、後の登録フォーム入力で上書きしない", async () => {
  // レビュー指摘 🟡-6: 上のテストは「既存 name が null」の場合しか作っておらず、
  // テスト名の「無い時だけ」の"だけ"(=既存名があるときは上書きしない)が無検証だった。
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", "既存の名前", "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput({ name: "New Name" }));

  assert.equal(result.name, "既存の名前", "既存 name があるときは上書きしない(coalesce(readers.name, excluded.name))");
});

test("name が空文字列だと reader.name は null になる（nullif 相当）", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-a", funnelId: "funnel-1", funnelSlug: "funnel-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput({ name: "" }));

  assert.equal(result.name, null);
});

test("購読解除済み(unsubscribed_at)の reader にはキューを一切積まず、即時送信も返さない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, unsubscribed_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "reader-unsub",
    "tenant-a",
    "reader@example.com",
    null,
    "old-access",
    "old-unsub",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(
    (db.prepare("select count(*) as c from deliveries").get() as { c: number }).c,
    0,
    "unsubscribed_at がある reader にはdeliveriesを一切積まない",
  );
  assert.equal(result.subject, null);
  assert.equal(result.body, null);
  assert.equal(result.initialDeliveryId, null);
  assert.equal(result.initialGrantLabelId, null);
});

test("購入済み(skip_if_purchased)なら1通目は skipped で積まれ、即時送信は返さない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    funnelProductId: "prod-1",
    stepMessages: [
      { id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null, skipIfPurchased: true },
      { id: "step-2", position: 1, delayMinutes: 60, sendAtHour: null },
    ],
  });
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, created_at) values (?, ?, ?, ?, ?)",
  ).run("prod-1", "tenant-a", "product", "price_x", NOW);
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-buyer", "tenant-a", "reader@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, purchased_at) values (?, ?, ?, ?, ?, ?)",
  ).run("purchase-1", "tenant-a", "reader-buyer", "prod-1", "sess-1", "2026-01-02T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const enrollment = db.prepare("select * from scenario_readers where reader_id = 'reader-buyer'").get() as Record<
    string,
    unknown
  >;
  const deliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ? order by step_message_id")
    .all(enrollment.id as string) as Array<Record<string, unknown>>;
  assert.equal(deliveries[0].status, "skipped");
  assert.equal(deliveries[0].error_message, "delivery condition not met");
  assert.equal(deliveries[1].status, "queued", "2通目は skip_if_purchased の対象外なので queued のまま");
  assert.equal(result.subject, null, "スキップ対象なので即時送信は返さない");
  assert.equal(result.initialDeliveryId, null);
});

test("funnel.product_id が未設定なら、テナント内のいずれかの購入でも購入済みスキップになる", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    funnelProductId: null,
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null, skipIfPurchased: true }],
  });
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, created_at) values (?, ?, ?, ?, ?)",
  ).run("prod-other", "tenant-a", "product", "price_x", NOW);
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-buyer", "tenant-a", "reader@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, purchased_at) values (?, ?, ?, ?, ?, ?)",
  ).run("purchase-1", "tenant-a", "reader-buyer", "prod-other", "sess-1", "2026-01-02T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(result.subject, null, "対象商品未設定なら任意の購入でスキップになる");
});

test("funnel.product_id が指定されているとき、別商品の購入だけではスキップされない", async () => {
  // レビュー指摘 🟡-3(1): 既存テストは (a) product_id一致 → skip、(b) product_id未設定 → skip
  // の2つとも肯定側で、「product_id が指定されているのに別商品の購入だけがある」否定側が無い。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    funnelProductId: "prod-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null, skipIfPurchased: true }],
  });
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, created_at) values (?, ?, ?, ?, ?)",
  ).run("prod-other", "tenant-a", "product", "price_x", NOW);
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-buyer", "tenant-a", "reader@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, purchased_at) values (?, ?, ?, ?, ?, ?)",
  ).run("purchase-1", "tenant-a", "reader-buyer", "prod-other", "sess-1", "2026-01-02T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const enrollment = db.prepare("select * from scenario_readers where reader_id = 'reader-buyer'").get() as Record<
    string,
    unknown
  >;
  const delivery = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(delivery.status, "processing", "対象商品(prod-1)を買っていないのでスキップされない");
  assert.equal(result.subject, "件名", "スキップ対象でないので即時送信を返す");
});

test("skip_if_purchased=0 のステップは、購入済みでもスキップされない", async () => {
  // レビュー指摘 🟡-3(2): initialStep.skip_if_purchased === 1 の判定自体(U9)が
  // 常時有効になっても、既存テストはどちらも skipIfPurchased: true しか使っていないため
  // 検知できない。skipIfPurchased を省略(=0)したステップで確認する。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    funnelProductId: "prod-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, created_at) values (?, ?, ?, ?, ?)",
  ).run("prod-1", "tenant-a", "product", "price_x", NOW);
  db.prepare(
    "insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-buyer", "tenant-a", "reader@example.com", null, "old-access", "old-unsub", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, purchased_at) values (?, ?, ?, ?, ?, ?)",
  ).run("purchase-1", "tenant-a", "reader-buyer", "prod-1", "sess-1", "2026-01-02T00:00:00.000Z");
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const enrollment = db.prepare("select * from scenario_readers where reader_id = 'reader-buyer'").get() as Record<
    string,
    unknown
  >;
  const delivery = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(delivery.status, "processing", "skip_if_purchased=0 のステップは購入済みでもスキップしない");
  assert.equal(result.subject, "件名", "スキップ対象でないので即時送信を返す");
});

test("initialStep の選定: delay_minutes>0 しか無いシナリオでは1通目が無く、全ステップが queued になる", async () => {
  // レビュー指摘 🟡-4(1): initialStep 検索の `delay_minutes = 0` 条件が無検証。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 60, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(result.subject, null, "delay_minutes=0 のステップが無いので1通目が無い");
  const statuses = (
    db.prepare("select status from deliveries where tenant_id = 'tenant-a'").all() as Array<{ status: string }>
  ).map((r) => r.status);
  assert.deepEqual(statuses, ["queued"], "processing が1件も無い(即時送信の対象が無い)");
});

test("initialStep の選定: delay_minutes=0 のステップが複数あれば position, id の昇順で最初の1件を選ぶ", async () => {
  // レビュー指摘 🟡-4(2): initialStep 検索の `order by position, id` が無検証。
  // insert 順(position 1 が先)と position 順(position 0 が先)をわざとずらす。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-later", position: 1, delayMinutes: 0, sendAtHour: null, subject: "position1の件名" },
      { id: "step-earlier", position: 0, delayMinutes: 0, sendAtHour: null, subject: "position0の件名" },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(result.subject, "position0の件名", "insert順ではなく position 昇順で最初の1件が選ばれる");
});

test("initialStep の選定: 配列の先頭(steps[0])ではなく、delay_minutes=0 のIDそのものでprocessing化する行を決める", async () => {
  // S18対策: steps一覧に order by position, id を足しただけでは、
  // 「配列の先頭 === delay_minutes=0 のステップ」という前提が崩れるケース
  // (最小position のステップが delay_minutes=0 ではない場合)を切り分けられない。
  // position 0 は delay_minutes>0(非initial)、position 1 が delay_minutes=0(=initial)にする。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-non-initial", position: 0, delayMinutes: 30, sendAtHour: null, subject: "非1通目" },
      { id: "step-initial", position: 1, delayMinutes: 0, sendAtHour: null, subject: "1通目" },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(result.subject, "1通目", "1通目はdelay_minutes=0のstep-initialのはず(配列先頭のstep-non-initialではない)");
  const deliveries = db
    .prepare("select * from deliveries where tenant_id = 'tenant-a'")
    .all() as Array<Record<string, unknown>>;
  assert.equal(
    deliveries.find((d) => d.step_message_id === "step-initial")?.status,
    "processing",
    "delay_minutes=0のstep-initialがprocessingになる(配列先頭ではなくID一致で判定)",
  );
  assert.equal(
    deliveries.find((d) => d.step_message_id === "step-non-initial")?.status,
    "queued",
    "配列先頭(position最小)というだけのstep-non-initialはprocessingにならない",
  );
  assert.equal(result.initialDeliveryId, deliveries.find((d) => d.step_message_id === "step-initial")?.id);
});

test("initialStep の選定: 同一テナントの別シナリオの delay_minutes=0 ステップを巻き込まない", async () => {
  // レビュー指摘 🟡-4(3): initialStep 検索の `scenario_id = ?` 絞りが無検証。
  // 別シナリオに position がより小さい delay_minutes=0 ステップを置く。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 5, delayMinutes: 0, sendAtHour: null, subject: "対象シナリオの件名" }],
  });
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("scenario-2", "tenant-a", "da-1", null, "scenario-2", 1, NOW);
  db.prepare(
    "insert into step_messages (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at) values (?, ?, ?, 0, 0, null, ?, 'b', ?)",
  ).run("s2-step-1", "tenant-a", "scenario-2", "別シナリオの件名(位置0)", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  assert.equal(result.subject, "対象シナリオの件名", "別シナリオのstep_messageは(positionが小さくても)initialStepに選ばれない");
});

test("再登録(既に同シナリオへ登録済み): subject/body は返さず、二重送信しない。10分未満なら再送キューへ積み直さない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const first = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));
  assert.equal(first.subject, "件名", "1回目は新規登録なので即時送信を返す");

  // 1回目の delivery はまだ 'processing'（呼び出し側が送信完了前）。
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(first.readerId) as Record<
    string,
    unknown
  >;
  const before = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(before.status, "processing");

  // 2回目: 5分後に同じメールで再登録（フォーム二重送信・リトライ等を想定）。
  const second = await registerReader(
    tenantA,
    baseInput({ now: "2026-09-14T03:05:00.000Z", accessToken: "access-2", unsubscribeToken: "unsub-2" }),
  );

  assert.equal(second.subject, null, "再登録では即時送信の材料を返さない（二重送信防止）");
  assert.equal(second.initialDeliveryId, null);
  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 1, "reader は増えない");
  assert.equal(
    (db.prepare("select count(*) as c from scenario_readers").get() as { c: number }).c,
    1,
    "scenario_readers も増えない(on conflict do update)",
  );

  const after = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(after.status, "processing", "10分未満のクールダウン内は processing のまま(積み直さない)");
});

test("再登録(10分以上経過): 送信中でない1通目を queued へ積み直す(連投抑止つき再送)", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const first = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(first.readerId) as Record<
    string,
    unknown
  >;
  // 呼び出し側が送信を完了させた想定で 'sent' に更新しておく(processingのままだと
  // 再送条件 status in ('sent','queued','failed','skipped') に含まれない)。
  // processing_started_at / error_message にわざと非nullの値を残しておく
  // (レビュー指摘 🟡-8: どちらも最初から null だと下のアサーションが空振りする)。
  db.prepare(
    "update deliveries set status = 'sent', sent_at = ?, processing_started_at = ?, error_message = ? where scenario_reader_id = ?",
  ).run("2026-09-14T03:00:05.000Z", "2026-09-14T03:00:01.000Z", "前回の失敗理由", enrollment.id as string);

  // 15分後に再登録。
  const second = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:15:00.000Z" }));

  assert.equal(second.subject, null, "再登録は新規登録ではないので即時送信は返さない");
  const after = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(after.status, "queued", "10分以上経過していれば queued に積み直す(通常配信バッチが拾う)");
  assert.equal(after.processing_started_at, null, "積み直すときに古い processing_started_at をクリアする");
  assert.equal(after.error_message, null, "積み直すときに古い error_message をクリアする");
});

test("再登録(クールダウン内・processingではない): 10分未満は積み直さない(クールダウン境界自体を検証する)", async () => {
  // レビュー指摘 🟡-1(1): 既存の「10分未満は積み直さない」テスト(:449相当)は1通目が
  // 'processing' のままなので requeue の status フィルタで弾かれ、クールダウンの境界値
  // (10分・符号)は一度も評価されていない。ここでは1通目を 'sent' にして processing 除外
  // フィルタを迂回し、クールダウン条件だけを単独で効かせる。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const first = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(first.readerId) as Record<
    string,
    unknown
  >;
  db.prepare("update deliveries set status = 'sent', sent_at = ? where scenario_reader_id = ?").run(
    "2026-09-14T03:00:05.000Z",
    enrollment.id as string,
  );

  // 5分後(クールダウン内)に再登録。
  const second = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:05:00.000Z" }));

  assert.equal(second.subject, null);
  const after = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(after.status, "sent", "クールダウン(10分)未満は積み直さない(processing除外とは無関係にこの条件単体で効く)");
});

test("再登録(processingのまま・クールダウンは経過済み): 送信中の行には触れない(processing除外を単独で検証する)", async () => {
  // レビュー指摘 🟡-1(2): 既存の「10分以上経過なら積み直す」テスト(:494相当)は1通目が
  // すでに 'sent' なので、processing 除外フィルタが効いているかは分からない
  // (クールダウンだけで説明がつく)。ここでは1通目を 'processing' のまま15分経過させ、
  // クールダウンは通過するが processing 除外だけで積み直されないことを確認する。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const first = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(first.readerId) as Record<
    string,
    unknown
  >;
  const before = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(before.status, "processing", "呼び出し側がまだ送信を完了させていない想定");

  // 15分後(クールダウンは通過)に再登録。
  const second = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:15:00.000Z" }));

  assert.equal(second.subject, null);
  const after = db
    .prepare("select * from deliveries where scenario_reader_id = ? and step_message_id = 'step-1'")
    .get(enrollment.id as string) as Record<string, unknown>;
  assert.equal(
    after.status,
    "processing",
    "クールダウンを過ぎていても、送信中(processing)の行は積み直さない(status in (...)から除外)",
  );
});

test("再登録の再送キューは、絞り込み条件(scenario_reader_id / step_message_id)の範囲だけに効く", async () => {
  // レビュー指摘 🟡-2: requeue の scenario_reader_id / step_message_id の絞り込みは、
  // 既存テストが「1シナリオ・1ステップ・1読者」のフィクスチャしか使っていないため無検証。
  // 3ステップ + 別読者のフィクスチャで、再登録した reader-1 の step-1 だけが積み直され、
  // reader-1 の他ステップも reader-other の全ステップも触られないことを確認する。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null },
      { id: "step-2", position: 1, delayMinutes: 60, sendAtHour: null },
      { id: "step-3", position: 2, delayMinutes: 120, sendAtHour: null },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const reader1 = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));
  const other = await registerReader(
    tenantA,
    baseInput({ now: "2026-09-14T03:00:00.000Z", email: "other@example.com", accessToken: "access-other", unsubscribeToken: "unsub-other" }),
  );

  // 全 deliveries を 'sent' + 15分以上前の sent_at にする(クールダウンを過ぎさせる)。
  db.prepare("update deliveries set status = 'sent', sent_at = ?").run("2026-09-14T02:30:00.000Z");

  await registerReader(tenantA, baseInput({ now: "2026-09-14T03:15:00.000Z" }));

  const reader1Enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(
    reader1.readerId,
  ) as Record<string, unknown>;
  const reader1Deliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ? order by step_message_id")
    .all(reader1Enrollment.id as string) as Array<Record<string, unknown>>;
  assert.equal(reader1Deliveries.find((d) => d.step_message_id === "step-1")?.status, "queued", "reader-1 の1通目だけが積み直される");
  assert.equal(
    reader1Deliveries.find((d) => d.step_message_id === "step-2")?.status,
    "sent",
    "step_message_id の絞り込みが効いていれば reader-1 の2通目は触られない",
  );
  assert.equal(
    reader1Deliveries.find((d) => d.step_message_id === "step-3")?.status,
    "sent",
    "step_message_id の絞り込みが効いていれば reader-1 の3通目は触られない",
  );

  const otherEnrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(
    other.readerId,
  ) as Record<string, unknown>;
  const otherDeliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ?")
    .all(otherEnrollment.id as string) as Array<Record<string, unknown>>;
  assert.ok(
    otherDeliveries.every((d) => d.status === "sent"),
    "scenario_reader_id の絞り込みが効いていれば reader-other の全ステップは触られない",
  );
});

test("再登録でも scenario_readers.registered_at / deadline_at は更新されない(on conflict do update は reader_id しか更新しない)", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    deadlineHours: 48,
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await registerReader(tenantA, baseInput({ now: "2026-08-01T00:00:00.000Z" }));
  const second = await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));

  const enrollment = db.prepare("select * from scenario_readers where tenant_id = 'tenant-a'").get() as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.registered_at, "2026-08-01T00:00:00.000Z", "1回目の登録時刻のまま");
  assert.equal(enrollment.deadline_at, "2026-08-03T00:00:00.000Z", "1回目の deadline のまま(48h)");
  assert.equal(
    second.deadlineAt,
    "2026-08-03T00:00:00.000Z",
    "レビュー指摘 🟡-7: 返り値の deadlineAt も DB と同じ1回目の期限であること(計算し直した値を返してはいけない)",
  );
});

test("テナント越境: 他テナントに同じ slug のファネルがあっても見えず、何も書き込まれない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, { tenantId: "tenant-b", funnelId: "funnel-1", funnelSlug: "funnel-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => registerReader(tenantA, baseInput()), ActiveRegistrationFunnelNotFoundError);

  assert.equal((db.prepare("select count(*) as c from readers").get() as { c: number }).c, 0);
});

test("テナント越境: 同じ email でも別テナントには別 reader が作られる", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1-a",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1-a",
    stepMessages: [{ id: "step-1-a", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  seedTenant(db, {
    tenantId: "tenant-b",
    funnelId: "funnel-1-b",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1-b",
    stepMessages: [{ id: "step-1-b", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");
  const tenantB = createTenantDb(executor, "tenant-b");

  await registerReader(tenantA, baseInput({ accessToken: "access-a", unsubscribeToken: "unsub-a" }));
  await registerReader(tenantB, baseInput({ accessToken: "access-b", unsubscribeToken: "unsub-b" }));

  const readers = db.prepare("select tenant_id, email from readers order by tenant_id").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(readers.length, 2, "同じメールでもテナントごとに別行になる");
  assert.deepEqual(
    readers.map((r) => r.tenant_id),
    ["tenant-a", "tenant-b"],
  );
});

test("step_messages は同一テナントの別シナリオぶんを巻き込まない", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run("scenario-2", "tenant-a", "da-1", null, "scenario-2", 1, NOW);
  for (const id of ["s2-step-1", "s2-step-2"]) {
    db.prepare(
      "insert into step_messages (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at) values (?, ?, ?, 0, 0, null, 's', 'b', ?)",
    ).run(id, "tenant-a", "scenario-2", NOW);
  }
  const tenantA = createTenantDb(executor, "tenant-a");

  await registerReader(tenantA, baseInput());

  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 1, "scenario-1 の step_messages(1件)ぶんだけが積まれる");
});

test("steps 一覧は insert 順ではなく position, id の昇順で並ぶ(order by の追加。レビュー指摘 🟢-1)", async () => {
  // position 0 のステップを2番目に insert し、それでも1通目(processing)として
  // 選ばれるのが position 0 の方であることを確認する。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-later", position: 1, delayMinutes: 60, sendAtHour: null },
      { id: "step-earlier", position: 0, delayMinutes: 0, sendAtHour: null, subject: "1通目" },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput());

  const deliveries = db
    .prepare("select * from deliveries where tenant_id = 'tenant-a' order by rowid")
    .all() as Array<Record<string, unknown>>;
  assert.equal(result.subject, "1通目", "insert 順(position 1 が先)ではなく position 0 が1通目に選ばれる");
  assert.equal(
    deliveries.find((d) => d.step_message_id === "step-earlier")?.status,
    "processing",
    "position 0(1通目)が processing",
  );
  assert.equal(
    deliveries.find((d) => d.step_message_id === "step-later")?.status,
    "queued",
    "position 1(2通目)は queued",
  );
});

test("email は trim もされる(前後の空白を除去してから小文字化)", async () => {
  // レビュー指摘 🟢-2: toLowerCase() は5件のテストで守られているが、trim() は無検証。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput({ email: "  Reader@Example.com  " }));

  assert.equal(result.email, "reader@example.com", "前後の空白が trim され、小文字化もされる");
  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  assert.equal(reader.email, "reader@example.com");
});

test("冪等性: 1回目の呼び出しの後は、想定より多い書き込みが発生していないことを呼び出し回数で確認する", async () => {
  const { db, executor: baseExecutor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
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

  await registerReader(tenantA, baseInput());
  const writeCalls = calls.filter((c) => /^\s*insert/i.test(c.sql));
  // readers upsert(1) + scenario_readers upsert(1) + deliveries insert(1チャンク) = 3。
  // reader_labels は registrationPath が null なので発生しない。
  assert.equal(writeCalls.length, 3, "書き込みは reader/scenario_readers/deliveries の3回だけのはず");
});

test("21ステップ以上のシナリオでも deliveries insert が D1 のバインドパラメータ上限を超えない（チャンク化）", async () => {
  const { db, executor } = createDb();
  const stepMessages = Array.from({ length: 21 }, (_, i) => ({
    id: `step-${i}`,
    position: i,
    delayMinutes: i,
    sendAtHour: null as number | null,
  }));
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
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

  await registerReader(tenantA, baseInput());

  assert.ok(
    deliveryInsertCalls.length >= 2,
    `21ステップ(1ステップ7パラメータ=147個)は1回のinsertには収まらずチャンク分割されるはず: ${deliveryInsertCalls.length}回`,
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

test("send_at_hour ありの配信予定時刻は process-stripe-purchase.ts と同じ computeStepScheduledAt を使う(JST丸め)", async () => {
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null },
      { id: "step-2", position: 1, delayMinutes: 60, sendAtHour: 9 },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  await registerReader(tenantA, baseInput({ now: "2026-09-14T03:00:00.000Z" }));

  const reader = db.prepare("select * from readers where tenant_id = 'tenant-a'").get() as Record<string, unknown>;
  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  const deliveries = db
    .prepare("select * from deliveries where scenario_reader_id = ? order by step_message_id")
    .all(enrollment.id as string) as Array<Record<string, unknown>>;
  assert.equal(deliveries[0].scheduled_at, "2026-09-14T03:00:00.000Z");
  assert.equal(deliveries[1].scheduled_at, "2026-09-14T00:00:00.000Z");
});

test("input.now はオフセット表記でも UTC(...Z)へ正規化してから使う(レビュー指摘 🟢-4)", async () => {
  // cooldownBoundary は toISOString() で必ず "...Z" になるのに対し、正規化していない
  // input.now をそのまま文字列比較に使うと、等価だが表記の異なる値(+09:00オフセット等)で
  // クールダウン判定が破綻しうる。入口で正規化していれば、オフセット表記で渡しても
  // DBには "...Z" 形式で保存され、後続の再登録のクールダウン判定も正しく効く。
  const { db, executor } = createDb();
  seedTenant(db, {
    tenantId: "tenant-a",
    funnelId: "funnel-1",
    funnelSlug: "funnel-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", position: 0, delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await registerReader(tenantA, baseInput({ now: "2026-09-14T12:00:00+09:00" }));

  assert.equal(result.deadlineAt, "2026-09-17T03:00:00.000Z", "+09:00 は UTC 03:00 と等価(72h後)");
  const reader = db.prepare("select * from readers where tenant_id = ?").get("tenant-a") as Record<string, unknown>;
  assert.equal(reader.created_at, "2026-09-14T03:00:00.000Z", "DBには常に ...Z 形式で保存される");
});
