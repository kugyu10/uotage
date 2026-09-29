// issue #29 [移行 P5]: import_scenario_readers (supabase/migrations/20260902010000 が最終版) の
// TS移植 (src/lib/readers/import-scenario-readers.ts) のテスト。
// node:sqlite に本物のスキーマ (cloudflare/d1/migrations/0001〜0004) を適用し、
// createTenantDb 越しに実行して Postgres 版と同じ結果になることを検証する。
//
// facts.md の重点観点（フィクスチャに候補行が1つしかないと絞り込み・並び替えが検証されない）
// を踏まえ、tenant/scenario/label の decoy 行を必ず1つ以上添えてから絞り込みを検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createTenantDb, type D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { D1_MAX_BIND_PARAMS } from "../../src/lib/delivery-queue/claim.ts";
import {
  ImportScenarioNotFoundError,
  InvalidDeliveryModeError,
  MAX_ROWS_PER_IMPORT_CALL,
  RegisteredAtRequiredError,
  TooManyImportRowsError,
  importScenarioReaders,
  type ImportScenarioReaderRow,
  type ImportScenarioReadersInput,
} from "../../src/lib/readers/import-scenario-readers.ts";

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

const NOW = "2026-09-01T00:00:00.000Z";

/** テナント1件ぶんのシナリオ（funnel任意）とステップを作る最小フィクスチャ。 */
function seedScenario(
  db: DatabaseSync,
  opts: {
    tenantId: string;
    scenarioId: string;
    funnelId?: string | null;
    deadlineHours?: number;
    stepMessages?: Array<{ id: string; position?: number; delayMinutes: number; sendAtHour: number | null }>;
  },
) {
  if (opts.funnelId) {
    db.prepare(
      "insert into funnels (id, tenant_id, name, slug, trigger_type, deadline_hours, is_active, created_at) values (?, ?, ?, ?, 'registration', ?, 1, ?)",
    ).run(opts.funnelId, opts.tenantId, "funnel", `${opts.funnelId}-slug`, opts.deadlineHours ?? 72, NOW);
  }
  db.prepare(
    "insert into scenarios (id, tenant_id, delivery_account_id, funnel_id, name, is_active, created_at) values (?, ?, ?, ?, ?, 1, ?)",
  ).run(opts.scenarioId, opts.tenantId, "da-1", opts.funnelId ?? null, "scenario", NOW);
  for (const step of opts.stepMessages ?? []) {
    db.prepare(
      `insert into step_messages
        (id, tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(step.id, opts.tenantId, opts.scenarioId, step.position ?? 0, step.delayMinutes, step.sendAtHour, "件名", "本文", NOW);
  }
}

function baseRow(overrides: Partial<ImportScenarioReaderRow> = {}): ImportScenarioReaderRow {
  return {
    email: "Reader@Example.com",
    name: "読者太郎",
    registrationPath: null,
    labels: [],
    customFields: {},
    accessToken: "access-1",
    unsubscribeToken: "unsub-1",
    unsubscribed: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ImportScenarioReadersInput> = {}): ImportScenarioReadersInput {
  return {
    scenarioId: "scenario-1",
    deliveryMode: "none",
    registeredAt: null,
    executedAt: NOW,
    rows: [baseRow()],
    ...overrides,
  };
}

function readers(db: DatabaseSync) {
  return db.prepare("select * from readers order by email").all() as Array<Record<string, unknown>>;
}

// ============================== 基本の登録 ==============================

test("新規readerを作成し、scenario_readersとdeliveriesを積む(delivery_mode='from_start')", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    deadlineHours: 48,
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({ deliveryMode: "from_start", executedAt: "2026-09-14T03:00:00.000Z" }),
  );

  assert.deepEqual(result, {
    createdReaders: 1,
    updatedReaders: 0,
    newEnrollments: 1,
    skippedEnrollments: 0,
    deliveriesQueued: 1,
  });

  const reader = readers(db)[0];
  assert.equal(reader.email, "reader@example.com", "メールは小文字化される");
  assert.equal(reader.name, "読者太郎");
  assert.equal(reader.custom_fields, "{}");
  assert.equal(reader.access_token, "access-1", "新規作成時はrowのaccessTokenがそのまま入る(取り違えていないか)");
  assert.equal(reader.unsubscribe_token, "unsub-1", "新規作成時はrowのunsubscribeTokenがそのまま入る(取り違えていないか)");
  assert.equal(reader.created_at, "2026-09-14T03:00:00.000Z", "readers.created_atはexecution_timeを明示的に入れる(差分7)");

  const enrollment = db.prepare("select * from scenario_readers where reader_id = ?").get(reader.id as string) as Record<
    string,
    unknown
  >;
  assert.equal(enrollment.registered_at, "2026-09-14T03:00:00.000Z", "'none'/'from_start' は執行時刻を登録日時にする");
  assert.equal(enrollment.deadline_at, "2026-09-16T03:00:00.000Z", "48時間後がdeadline");
});

test("scenarioにfunnelが無ければ deadline_at は registered_at と同じ(deadline_hoursを加算しない)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" }); // funnelId 無し
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ executedAt: "2026-09-14T03:00:00.000Z" }));

  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(enrollment.registered_at, "2026-09-14T03:00:00.000Z");
  assert.equal(enrollment.deadline_at, "2026-09-14T03:00:00.000Z", "funnel が無いので加算されない");
});

// ============================== ガード ==============================

test("行数が上限(1000)を超えると例外を投げ、何も書き込まない", async () => {
  const { db, executor } = createDb();
  // scenario をあえて作らない: ガードが scenario 解決より先に効くことも同時に確認する。
  const tenantA = createTenantDb(executor, "tenant-a");
  const rows = Array.from({ length: MAX_ROWS_PER_IMPORT_CALL + 1 }, (_, i) =>
    baseRow({ email: `reader-${i}@example.com` }),
  );

  await assert.rejects(() => importScenarioReaders(tenantA, baseInput({ rows })), TooManyImportRowsError);
  assert.equal(readers(db).length, 0, "行数超過時は1件も書き込まれない");
});

test("delivery_mode が不正な値だと例外を投げる", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () => importScenarioReaders(tenantA, baseInput({ deliveryMode: "bogus" as never })),
    InvalidDeliveryModeError,
  );
  assert.equal(readers(db).length, 0);
});

test("delivery_mode='from_now' で registeredAt が無いと例外を投げる", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(
    () => importScenarioReaders(tenantA, baseInput({ deliveryMode: "from_now", registeredAt: null })),
    RegisteredAtRequiredError,
  );
  assert.equal(readers(db).length, 0);
});

test("scenarioが同一テナントに存在しないと例外を投げる（別テナントのdecoyは巻き込まない）", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-b", scenarioId: "scenario-1" }); // decoy: 別テナントの同一ID
  const tenantA = createTenantDb(executor, "tenant-a");

  await assert.rejects(() => importScenarioReaders(tenantA, baseInput()), ImportScenarioNotFoundError);
  assert.equal(readers(db).length, 0);
});

test("同一テナントに複数のscenario/funnelがあっても id で正しく絞り込まれる(decoyを先に挿入)", async () => {
  const { db, executor } = createDb();
  // scenarios/funnels には (tenant_id, funnel_id, is_active) 等の複合索引があり、
  // `id = ?` の絞り込みを外すと SQLite は挿入順ではなく索引キー(funnel_id/id の
  // 文字列順)で行を返す。decoy 側の funnel_id を target ("funnel-1") より
  // 辞書順で小さい "funnel-0-decoy" にすることで、絞り込みが外れたときに
  // 真っ先にdecoyが返ってくる状況を作る(facts.mdの「decoy配置は索引順を意識する」)。
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-decoy",
    funnelId: "funnel-0-decoy",
    deadlineHours: 999,
  });
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    deadlineHours: 48,
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({ scenarioId: "scenario-1", deliveryMode: "from_start", executedAt: "2026-09-14T03:00:00.000Z" }),
  );

  assert.equal(result.deliveriesQueued, 1, "targetシナリオのstepだけが積まれる(decoyのfunnelの999時間は使われない)");
  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(enrollment.scenario_id, "scenario-1", "idの絞り込みが外れるとdecoyのscenarioに解決されうる");
  assert.equal(
    enrollment.deadline_at,
    "2026-09-16T03:00:00.000Z",
    "funnel-1(48時間)で計算される。funnel-0-decoy(999時間)ではない",
  );
});

// ============================== readers upsert ==============================

test("既存readerがある場合、name は「新値が空でなければ新値を優先」(register_readerと逆の規則)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", "既存の名前", "{}", "old-access", "old-unsub", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ name: "新しい名前" })] }));

  assert.equal(result.updatedReaders, 1);
  assert.equal(result.createdReaders, 0);
  const reader = readers(db)[0];
  assert.equal(reader.name, "新しい名前", "importは新値を優先する(register_readerは既存優先で逆)");
  assert.equal(reader.access_token, "old-access", "アクセストークンは新規作成時にしか設定しない");
});

test("新しい名前が空文字列なら既存の名前を維持する(nullif('')と同じ)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", "既存の名前", "{}", "old-access", "old-unsub", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ name: "" })] }));

  assert.equal(readers(db)[0].name, "既存の名前");
});

test("custom_fields は既存値と浅くマージされ、同名キーは新しい値で上書きされる", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", "既存", JSON.stringify({ a: 1, b: "old" }), "old-access", "old-unsub", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ customFields: { b: "new", c: 3 } })] }));

  const reader = readers(db)[0];
  assert.deepEqual(JSON.parse(reader.custom_fields as string), { a: 1, b: "new", c: 3 });
});

test("unsubscribed_atは未設定のときだけ立ち、既に設定済みなら上書きされない(coalesce)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(
    tenantA,
    baseInput({ executedAt: "2026-09-14T03:00:00.000Z", rows: [baseRow({ unsubscribed: true })] }),
  );
  let reader = readers(db)[0];
  assert.equal(reader.unsubscribed_at, "2026-09-14T03:00:00.000Z");

  // 2回目: unsubscribed=false でも一度立った unsubscribed_at はクリアされない。
  await importScenarioReaders(
    tenantA,
    baseInput({
      scenarioId: "scenario-1",
      executedAt: "2026-09-15T00:00:00.000Z",
      rows: [baseRow({ unsubscribed: false })],
    }),
  );
  reader = readers(db)[0];
  assert.equal(reader.unsubscribed_at, "2026-09-14T03:00:00.000Z", "一度立ったunsubscribed_atは維持される");

  // 3回目: unsubscribed=true をもう一度渡しても、既に設定済みの日時を新しい実行時刻で
  // 上書きしない（coalesce(unsubscribed_at, execution_time) は既存値がある限りそちらを使う）。
  await importScenarioReaders(
    tenantA,
    baseInput({
      scenarioId: "scenario-1",
      executedAt: "2026-09-20T00:00:00.000Z",
      rows: [baseRow({ unsubscribed: true })],
    }),
  );
  reader = readers(db)[0];
  assert.equal(
    reader.unsubscribed_at,
    "2026-09-14T03:00:00.000Z",
    "unsubscribed=trueを再度渡しても、既に設定済みの日時が新しい実行時刻で上書きされない",
  );
});

test("unsubscribed=falseで既存が未解除なら unsubscribed_at は null のまま", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "reader@example.com", "既存", "{}", "old-access", "old-unsub", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ unsubscribed: false })] }));

  assert.equal(readers(db)[0].unsubscribed_at, null);
});

test("別テナントに同一メールの既存readerがあっても巻き込まない(decoy)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-tenant-b", "tenant-b", "reader@example.com", "テナントBの名前", "{}", "b-access", "b-unsub", NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(tenantA, baseInput());

  assert.equal(result.createdReaders, 1, "tenant-bの行はupdateの対象にならず、tenant-aで新規作成される");
  const tenantBReader = db.prepare("select * from readers where tenant_id = 'tenant-b'").get() as Record<string, unknown>;
  assert.equal(tenantBReader.name, "テナントBの名前", "tenant-bの行は変更されない");
});

// ============================== labels ==============================

test("存在しないラベルは自動作成して付与し、既存ラベルは再利用する(重複作成しない)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  // 索引順(name昇順)で「アラベル」<「新規ラベル」になるようにし、かつ
  // decoyを先に挿入して rowid も「アラベル」の方が小さくなるようにする。
  // `name = ?` の絞り込みが外れた場合、tenant-a の全ラベルを ORDER BY 無しで
  // 取得したときに真っ先に返ってくるのが「アラベル」(既存・誤答)になるため、
  // 「新規ラベル」の解決を壊すと必ず検出できる(facts.mdの「decoy配置は索引順を意識する」)。
  db.prepare("insert into labels (id, tenant_id, name, created_at) values (?, ?, ?, ?)").run(
    "label-existing",
    "tenant-a",
    "アラベル",
    NOW,
  );
  // decoy: 別テナントの同名ラベル。tenant-a側の解決に巻き込まれないこと。
  db.prepare("insert into labels (id, tenant_id, name, created_at) values (?, ?, ?, ?)").run(
    "label-tenant-b",
    "tenant-b",
    "アラベル",
    NOW,
  );
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(
    tenantA,
    baseInput({
      executedAt: "2026-09-14T03:00:00.000Z",
      rows: [baseRow({ labels: ["アラベル", "新規ラベル", " "] })],
    }),
  );

  const labelsInTenantA = db.prepare("select * from labels where tenant_id = 'tenant-a'").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(labelsInTenantA.length, 2, "既存ラベルは再利用され、新規ラベルだけ増える(空白のみの項目は無視)");
  assert.deepEqual(
    labelsInTenantA.map((l) => l.name).sort(),
    ["アラベル", "新規ラベル"],
  );
  const newLabel = labelsInTenantA.find((l) => l.name === "新規ラベル") as Record<string, unknown>;
  assert.equal(
    newLabel.created_at,
    "2026-09-14T03:00:00.000Z",
    "labels.created_atはexecution_timeを明示的に入れる(差分7)",
  );

  const reader = readers(db)[0];
  const attached = db.prepare("select * from reader_labels where reader_id = ? order by label_id").all(
    reader.id as string,
  ) as Array<Record<string, unknown>>;
  assert.equal(attached.length, 2, "既存ラベルと新規ラベルの両方が付与される");
  for (const row of attached) {
    assert.equal(
      row.granted_at,
      "2026-09-14T03:00:00.000Z",
      "reader_labels.granted_atはexecution_timeを明示的に入れる(差分7)",
    );
  }

  const labelsCountAll = db.prepare("select count(*) as c from labels").get() as { c: number };
  assert.equal(labelsCountAll.c, 3, "テナント境界を越えてラベルが再利用・複製されていない(既存2 + 新規1)");
});

test("同一行内で同じラベル名が重複しても reader_labels は1件しか作られない", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ labels: ["重複", "重複"] })] }));

  const reader = readers(db)[0];
  const attached = db.prepare("select * from reader_labels where reader_id = ?").all(reader.id as string);
  assert.equal(attached.length, 1);
});

// ============================== registration_path ==============================

test("registration_pathが空文字列ならnull扱いになる(nullif)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ registrationPath: "" })] }));

  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(enrollment.registration_path, null);
});

test("registration_pathが非空文字列ならそのまま保存される(nullに落ちていないか)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  await importScenarioReaders(tenantA, baseInput({ rows: [baseRow({ registrationPath: "csv-import" })] }));

  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(enrollment.registration_path, "csv-import");
});

// ============================== 冪等性(既に登録済み) ==============================

test("同じ(reader,scenario)を再実行しても二重登録せず、期限をリセットしない", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    deadlineHours: 24,
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const first = await importScenarioReaders(
    tenantA,
    baseInput({ deliveryMode: "from_start", executedAt: "2026-09-14T03:00:00.000Z" }),
  );
  assert.equal(first.newEnrollments, 1);
  assert.equal(first.skippedEnrollments, 0);

  // 再実行(同じCSVをもう一度確定実行したケースを模す)。時刻は進めて、期限がリセットされないことを検証する。
  const second = await importScenarioReaders(
    tenantA,
    baseInput({ deliveryMode: "from_start", executedAt: "2026-09-20T00:00:00.000Z" }),
  );
  assert.equal(second.newEnrollments, 0);
  assert.equal(second.skippedEnrollments, 1);
  assert.equal(second.deliveriesQueued, 0, "スキップした行にはdeliveriesを積まない");

  const enrollments = db.prepare("select * from scenario_readers").all();
  assert.equal(enrollments.length, 1, "二重登録されない");
  const enrollment = enrollments[0] as Record<string, unknown>;
  assert.equal(enrollment.registered_at, "2026-09-14T03:00:00.000Z", "期限(登録日時)はリセットされない");

  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 1, "deliveriesも二重に積まれない");
});

test("同一バッチ内で同じメールの行が2回来ても2重登録しない(重複CSV行)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1" });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({ rows: [baseRow({ name: "1回目" }), baseRow({ name: "2回目" })] }),
  );

  assert.equal(result.createdReaders, 1, "1回目でinsert");
  assert.equal(result.updatedReaders, 1, "2回目は同一バッチ内でも既存を見つけてupdateになる");
  assert.equal(result.newEnrollments, 1);
  assert.equal(result.skippedEnrollments, 1, "2回目のscenario_readersは1回目とconflictしてskip");
  assert.equal(readers(db).length, 1);
  assert.equal(readers(db)[0].name, "2回目", "最後の行の値が反映される");
});

// ============================== delivery_mode の3パターン ==============================

test("delivery_mode='none' は新規登録してもdeliveriesを一切積まない", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-1", delayMinutes: 0, sendAtHour: null },
      // 'none' のガードが無くても、下流の時刻フィルタ(> executionTime)だけで0件を
      // 作ってしまうケース(delay=0分)が偶然存在するため、そちらでは通過してしまう
      // step(実行時刻より未来)を混ぜて、'none' ガード自体の効果を単独で検証する。
      { id: "step-future", delayMinutes: 60 * 24, sendAtHour: null },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(tenantA, baseInput({ deliveryMode: "none" }));

  assert.equal(result.newEnrollments, 1);
  assert.equal(result.deliveriesQueued, 0);
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 0);
});

test("delivery_mode='from_now' はregisteredAtを登録日時にし、実行時刻より過去のステップは積まない(境界を含む3本のステップで判別)", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    // 過去日をregisteredAtに指定するケース。
    // - step-past: delay=0分 → scheduledAt は registeredAt そのもの(= 09-01)。
    // - step-between: registeredAtより後・実行時刻より前(09-06)。積まれてはいけない。
    //   ここが無いと「フィルタの基準が registeredAt に化けている」バグ(境界の両側にしか
    //   ステップが無いと検出できない)を見逃す。
    // - step-boundary: scheduledAt が実行時刻とちょうど一致(09-14T03:00)。境界は`>`で
    //   排他のはずなので積まれてはいけない(`>=`に緩んでいないかの検証)。
    // - step-future: 実行時刻より後(09-21)。これだけが積まれる。
    stepMessages: [
      { id: "step-past", delayMinutes: 0, sendAtHour: null }, // 09-01 (= registeredAt)
      { id: "step-between", delayMinutes: 60 * 24 * 5, sendAtHour: null }, // 09-06
      { id: "step-boundary", delayMinutes: 60 * 24 * 13 + 180, sendAtHour: null }, // 09-14T03:00 (= executedAt ちょうど)
      { id: "step-future", delayMinutes: 60 * 24 * 20, sendAtHour: null }, // +20日 (2026-09-01 + 20日 = 09-21)
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({
      deliveryMode: "from_now",
      registeredAt: "2026-09-01T00:00:00.000Z", // 過去
      executedAt: "2026-09-14T03:00:00.000Z", // 実行時刻(基準)。09-01+20日(09-21)はこれより後
    }),
  );

  assert.equal(result.deliveriesQueued, 1, "実行時刻より未来のステップだけ積む(registeredAt基準に化けていないか)");
  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(enrollment.registered_at, "2026-09-01T00:00:00.000Z", "from_nowは指定日時を登録日時にする");

  const queued = db.prepare("select * from deliveries").all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    queued.map((r) => r.step_message_id),
    ["step-future"],
    "積まれるのはstep-futureのみ(step-between/step-boundaryが混ざっていないか)",
  );
});

test("deliveriesの行全体(reader_id/scenario_reader_id/scheduled_at)とdeadline_atの基準を具体値で検証する", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    funnelId: "funnel-1",
    deadlineHours: 48,
    stepMessages: [
      // send_at_hour が null: scheduledAt はそのまま registered_at + delay_minutes。
      { id: "step-null-hour", delayMinutes: 60 * 24 * 19, sendAtHour: null }, // 09-01 + 19日 = 09-20T00:00:00Z
      // send_at_hour = 9: JST日付の09:00に丸められる。base(registered_at+delay)は
      // 09-21T03:00:00Z(JSTでは12:00)で09:00ちょうどではないため、丸めていることが
      // 具体値の違いとして検出できる。
      { id: "step-9-hour", delayMinutes: 60 * 24 * 20 + 180, sendAtHour: 9 }, // base = 09-21T03:00:00Z
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({
      deliveryMode: "from_now",
      registeredAt: "2026-09-01T00:00:00.000Z",
      executedAt: "2026-09-14T03:00:00.000Z",
    }),
  );

  assert.equal(result.deliveriesQueued, 2);

  const enrollment = db.prepare("select * from scenario_readers").get() as Record<string, unknown>;
  assert.equal(
    enrollment.deadline_at,
    "2026-09-03T00:00:00.000Z",
    "deadline_atはregistered_at(from_nowの指定日時)+48時間。executedAt+48時間ではない",
  );

  const reader = readers(db)[0];
  const queued = db.prepare("select * from deliveries order by step_message_id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    queued.map((r) => r.step_message_id),
    ["step-9-hour", "step-null-hour"],
  );
  for (const row of queued) {
    assert.equal(row.reader_id, reader.id, "reader_idが正しい読者を指しているか(enrollment.idと取り違えていないか)");
    assert.equal(
      row.scenario_reader_id,
      enrollment.id,
      "scenario_reader_idが正しいenrollmentを指しているか(reader.idと取り違えていないか)",
    );
    assert.equal(row.status, "queued");
  }

  const nullHourRow = queued.find((r) => r.step_message_id === "step-null-hour") as Record<string, unknown>;
  assert.equal(
    nullHourRow.scheduled_at,
    "2026-09-20T00:00:00.000Z",
    "send_at_hourがnullならregistered_at+delay_minutesそのまま",
  );

  const hour9Row = queued.find((r) => r.step_message_id === "step-9-hour") as Record<string, unknown>;
  assert.equal(
    hour9Row.scheduled_at,
    "2026-09-21T00:00:00.000Z",
    "send_at_hour=9はJST日付の09:00(UTCでは00:00)に丸められる",
  );
});

test("delivery_mode='from_start' は過去日になるステップも含めて全ステップ積む", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    stepMessages: [
      { id: "step-past", delayMinutes: 0, sendAtHour: null },
      { id: "step-future", delayMinutes: 60 * 24 * 10, sendAtHour: null },
    ],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({
      deliveryMode: "from_start",
      executedAt: "2026-09-14T03:00:00.000Z",
    }),
  );

  assert.equal(result.deliveriesQueued, 2, "from_startは過去日になるステップも積む");
});

test("解除済み(unsubscribed=true)の新規readerにはdeliveriesを一切積まない", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({ deliveryMode: "from_start", rows: [baseRow({ unsubscribed: true })] }),
  );

  assert.equal(result.newEnrollments, 1, "登録自体はされる");
  assert.equal(result.deliveriesQueued, 0, "解除済みreaderにはdeliveriesを積まない");
});

test("同一シナリオの別ステップ(decoy)や別シナリオのステップは巻き込まない", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  // decoy: 別シナリオのstep_message。tenant/scenario双方の絞り込みが正しいことを検証する。
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-2",
    stepMessages: [{ id: "step-other-scenario", delayMinutes: 0, sendAtHour: null }],
  });
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(tenantA, baseInput({ deliveryMode: "from_start" }));

  assert.equal(result.deliveriesQueued, 1, "対象シナリオのステップだけが積まれる");
  const queued = db.prepare("select * from deliveries").all() as Array<Record<string, unknown>>;
  assert.equal(queued[0].step_message_id, "step-1");
});

// ============================== バインドパラメータのチャンク化 ==============================

test("ステップが多いシナリオでも deliveries insert が D1 のバインドパラメータ上限を超えない（チャンク化）", async () => {
  const { db, executor } = createDb();
  const stepMessages = Array.from({ length: 20 }, (_, i) => ({
    id: `step-${i}`,
    delayMinutes: i,
    sendAtHour: null as number | null,
  }));
  seedScenario(db, { tenantId: "tenant-a", scenarioId: "scenario-1", stepMessages });

  const deliveryInsertCalls: Array<{ params: readonly (string | number | null)[] }> = [];
  const recordingExecutor: D1Executor = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
      if (/insert into deliveries/.test(sql)) deliveryInsertCalls.push({ params });
      return executor.all<T>(sql, params);
    },
    run(sql: string, params: readonly (string | number | null)[]) {
      return executor.run(sql, params);
    },
  };
  const tenantA = createTenantDb(recordingExecutor, "tenant-a");

  const result = await importScenarioReaders(tenantA, baseInput({ deliveryMode: "from_start" }));

  assert.equal(result.deliveriesQueued, 20, "全ステップぶんの配信予定が作られる（チャンク分割しても欠落しない）");
  assert.ok(
    deliveryInsertCalls.length >= 2,
    `20ステップ(1ステップ6パラメータ=120個)は1回のinsertには収まらずチャンク分割されるはず: ${deliveryInsertCalls.length}回`,
  );
  for (const call of deliveryInsertCalls) {
    assert.ok(
      call.params.length <= D1_MAX_BIND_PARAMS,
      `1回の insert deliveries のパラメータ数が D1 の上限を超えている: ${call.params.length}`,
    );
  }
  const deliveryCount = db.prepare("select count(*) as c from deliveries").get() as { c: number };
  assert.equal(deliveryCount.c, 20);
});

// ============================== 複数行の集計 ==============================

test("複数行の混在(新規/既存更新/スキップ)でサマリが正しく合算される", async () => {
  const { db, executor } = createDb();
  seedScenario(db, {
    tenantId: "tenant-a",
    scenarioId: "scenario-1",
    stepMessages: [{ id: "step-1", delayMinutes: 0, sendAtHour: null }],
  });
  db.prepare(
    "insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("reader-existing", "tenant-a", "existing@example.com", "既存", "{}", "old-access", "old-unsub", NOW);
  db.prepare(
    "insert into scenario_readers (id, tenant_id, reader_id, scenario_id, registered_at, deadline_at) values (?, ?, ?, ?, ?, ?)",
  ).run("enrollment-existing", "tenant-a", "reader-existing", "scenario-1", NOW, NOW);
  const tenantA = createTenantDb(executor, "tenant-a");

  const result = await importScenarioReaders(
    tenantA,
    baseInput({
      deliveryMode: "from_start",
      rows: [
        baseRow({ email: "new1@example.com", accessToken: "access-new1", unsubscribeToken: "unsub-new1" }),
        baseRow({ email: "new2@example.com", accessToken: "access-new2", unsubscribeToken: "unsub-new2" }),
        baseRow({ email: "existing@example.com", name: "更新後" }), // 既に登録済みなのでskip
      ],
    }),
  );

  assert.deepEqual(result, {
    createdReaders: 2,
    updatedReaders: 1,
    newEnrollments: 2,
    skippedEnrollments: 1,
    deliveriesQueued: 2,
  });
});
