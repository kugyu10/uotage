// issue #10 [移行 P4]: D1 用キュー操作エンジンのテスト。
// D1 は SQLite なので、node:sqlite のインメモリ DB に本物のスキーマ
// (cloudflare/d1/migrations/0001_deliveries.sql) を適用し、実際に SQL を実行して検証する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  claimDueDeliveries,
  DELIVERY_CLAIM_MAX_BATCH,
  markDeliveriesSkipped,
  markDeliverySent,
  MAX_DELIVERY_ATTEMPTS,
  recoverStuckDeliveries,
  releaseDeliveryFailure,
  shouldSkipDelivery,
  toQueueTimestamp,
  type QueueDb,
} from "../../src/lib/delivery-queue/claim.ts";

const SCHEMA = readFileSync(
  new URL("../../cloudflare/d1/migrations/0001_deliveries.sql", import.meta.url),
  "utf8",
);

const NOW = new Date("2026-09-14T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return toQueueTimestamp(new Date(NOW.getTime() - minutes * 60_000));
}

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const queue: QueueDb = {
    all<T>(sql: string, params: readonly (string | number | null)[]) {
      return Promise.resolve(db.prepare(sql).all(...params) as T[]);
    },
    run(sql: string, params: readonly (string | number | null)[]) {
      db.prepare(sql).run(...params);
      return Promise.resolve();
    },
  };
  return { db, queue };
}

interface DeliveryRow {
  id: string;
  status?: string;
  scheduled_at?: string;
  attempt_count?: number;
  processing_started_at?: string | null;
  scenario_reader_id?: string;
  step_message_id?: string;
  error_message?: string | null;
}

function insertDelivery(db: DatabaseSync, row: DeliveryRow): void {
  db.prepare(
    `insert into deliveries (id, tenant_id, scenario_reader_id, step_message_id, reader_id,
       scheduled_at, status, attempt_count, processing_started_at, error_message)
     values (?, 't1', ?, ?, 'r1', ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.scenario_reader_id ?? `sr-${row.id}`,
    row.step_message_id ?? `sm-${row.id}`,
    row.scheduled_at ?? minutesAgo(5),
    row.status ?? "queued",
    row.attempt_count ?? 0,
    row.processing_started_at ?? null,
    row.error_message ?? null,
  );
}

function getRow(db: DatabaseSync, id: string) {
  return db.prepare("select * from deliveries where id = ?").get(id) as Record<string, unknown>;
}

test("UNIQUE(scenario_reader_id, step_message_id) が維持されている（二重キュー投入の冪等性）", () => {
  const { db } = createDb();
  insertDelivery(db, { id: "d1", scenario_reader_id: "sr", step_message_id: "sm" });
  assert.throws(() => insertDelivery(db, { id: "d2", scenario_reader_id: "sr", step_message_id: "sm" }));
});

test("claim は期限が来た queued 行だけを scheduled_at, id 順に batchLimit 件まで processing にする", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d-late", scheduled_at: minutesAgo(1) });
  insertDelivery(db, { id: "d-early", scheduled_at: minutesAgo(30) });
  insertDelivery(db, { id: "d-mid", scheduled_at: minutesAgo(10) });
  insertDelivery(db, { id: "d-future", scheduled_at: toQueueTimestamp(new Date(NOW.getTime() + 60_000)) });
  insertDelivery(db, { id: "d-sent", status: "sent", scheduled_at: minutesAgo(30) });

  const claimed = await claimDueDeliveries(queue, NOW, 2);

  assert.deepEqual(claimed.map((row) => row.id), ["d-early", "d-mid"], "古い順に claim すべき");
  assert.equal(claimed[0].attempt_count, 1, "claim で attempt_count がインクリメントされる");
  assert.equal(getRow(db, "d-early").status, "processing");
  assert.equal(getRow(db, "d-early").processing_started_at, toQueueTimestamp(NOW));
  assert.equal(getRow(db, "d-late").status, "queued", "batchLimit を超えた行は残る");
  assert.equal(getRow(db, "d-future").status, "queued", "期限前の行は claim しない");
  assert.equal(getRow(db, "d-sent").status, "sent", "queued 以外の行に触らない");
});

test("claim は targetDeliveryId 指定時にその1行だけを対象にする", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d1", scheduled_at: minutesAgo(30) });
  insertDelivery(db, { id: "d2", scheduled_at: minutesAgo(20) });

  const claimed = await claimDueDeliveries(queue, NOW, DELIVERY_CLAIM_MAX_BATCH, "d2");

  assert.deepEqual(claimed.map((row) => row.id), ["d2"]);
  assert.equal(getRow(db, "d1").status, "queued");
});

test("claim の batchLimit は 1〜上限の整数のみ受け付ける（RPC と同じガード）", async () => {
  const { queue } = createDb();
  for (const bad of [0, -1, DELIVERY_CLAIM_MAX_BATCH + 1, 1.5, Number.NaN]) {
    await assert.rejects(() => claimDueDeliveries(queue, NOW, bad), /batch_limit/);
  }
});

test("claim の候補選択は (status, scheduled_at) インデックスを使う（D1 の rows read 課金対策）", () => {
  const { db } = createDb();
  const plan = db
    .prepare(
      `explain query plan select id from deliveries
       where status = 'queued' and scheduled_at <= ? order by scheduled_at, id limit ?`,
    )
    .all(toQueueTimestamp(NOW), 500) as Array<{ detail: string }>;
  const detail = plan.map((row) => row.detail).join(" / ");
  assert.match(detail, /deliveries_status_scheduled_at/, `フルスキャンになっている: ${detail}`);
});

test("スタック復旧: 10分超の processing は queued に戻り、試行上限に達した行は failed で打ち止め", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d-stuck", status: "processing", attempt_count: 1, processing_started_at: minutesAgo(11) });
  insertDelivery(db, {
    id: "d-exhausted",
    status: "processing",
    attempt_count: MAX_DELIVERY_ATTEMPTS,
    processing_started_at: minutesAgo(11),
  });
  insertDelivery(db, { id: "d-fresh", status: "processing", attempt_count: 1, processing_started_at: minutesAgo(9) });
  insertDelivery(db, { id: "d-null-started", status: "processing", attempt_count: 1, processing_started_at: null, scheduled_at: minutesAgo(11) });

  await recoverStuckDeliveries(queue, NOW);

  assert.equal(getRow(db, "d-stuck").status, "queued");
  assert.equal(getRow(db, "d-stuck").processing_started_at, null);
  assert.equal(getRow(db, "d-exhausted").status, "failed");
  assert.equal(getRow(db, "d-exhausted").error_message, "processing timeout after maximum retries");
  assert.equal(getRow(db, "d-fresh").status, "processing", "10分未満の行は触らない");
  assert.equal(getRow(db, "d-null-started").status, "queued", "processing_started_at が null なら scheduled_at 基準で復旧");
});

test("markDeliverySent は processing の行にしか効かない（二重呼び出しで sent を上書きしない）", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d1", status: "processing", processing_started_at: minutesAgo(1) });

  await markDeliverySent(queue, "d1", "resend-abc", NOW);
  assert.equal(getRow(db, "d1").status, "sent");
  assert.equal(getRow(db, "d1").resend_message_id, "resend-abc");

  // 2回目（例えば cron の重複実行）は status='processing' 条件に合わず何も変えない。
  await markDeliverySent(queue, "d1", "resend-other", new Date(NOW.getTime() + 1000));
  assert.equal(getRow(db, "d1").resend_message_id, "resend-abc");
});

test("releaseDeliveryFailure は試行上限までは queued に戻し、上限で failed にする。message は500文字で切る", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d-retry", status: "processing", attempt_count: 1, processing_started_at: minutesAgo(1) });
  insertDelivery(db, {
    id: "d-final",
    status: "processing",
    attempt_count: MAX_DELIVERY_ATTEMPTS,
    processing_started_at: minutesAgo(1),
  });

  await releaseDeliveryFailure(queue, "d-retry", "boom");
  await releaseDeliveryFailure(queue, "d-final", "x".repeat(1000));

  assert.equal(getRow(db, "d-retry").status, "queued");
  assert.equal(getRow(db, "d-retry").error_message, "boom");
  assert.equal(getRow(db, "d-final").status, "failed");
  assert.equal((getRow(db, "d-final").error_message as string).length, 500);
});

test("markDeliveriesSkipped は指定した processing の行だけを skipped にする", async () => {
  const { db, queue } = createDb();
  insertDelivery(db, { id: "d1", status: "processing", processing_started_at: minutesAgo(1) });
  insertDelivery(db, { id: "d2", status: "processing", processing_started_at: minutesAgo(1) });
  insertDelivery(db, { id: "d3", status: "sent" });

  await markDeliveriesSkipped(queue, ["d1", "d3"]);

  assert.equal(getRow(db, "d1").status, "skipped");
  assert.equal(getRow(db, "d1").error_message, "delivery condition not met");
  assert.equal(getRow(db, "d2").status, "processing", "指定していない行に触らない");
  assert.equal(getRow(db, "d3").status, "sent", "processing 以外の行に触らない");
});

test("shouldSkipDelivery は Postgres 版の skipped 判定と同じ意味論を持つ", () => {
  const base = {
    readerUnsubscribed: false,
    enrollmentStatus: "active",
    skipIfPurchased: true,
    scenarioHasPurchaseTrigger: false,
    targetProductId: "p1",
    purchasedProductIds: [] as string[],
  };

  assert.equal(shouldSkipDelivery({ ...base, readerUnsubscribed: true }), true, "解除済み読者");
  assert.equal(shouldSkipDelivery({ ...base, enrollmentStatus: "stopped" }), true, "停止した登録");
  assert.equal(shouldSkipDelivery({ ...base, enrollmentStatus: "completed" }), true, "完了した登録");
  assert.equal(shouldSkipDelivery({ ...base, purchasedProductIds: ["p1"] }), true, "対象商品を購入済み");
  assert.equal(shouldSkipDelivery({ ...base, purchasedProductIds: ["p2"] }), false, "別商品の購入ではスキップしない");
  assert.equal(shouldSkipDelivery(base), false, "未購入なら送る");
  assert.equal(
    shouldSkipDelivery({ ...base, targetProductId: null, purchasedProductIds: ["anything"] }),
    true,
    "対象商品が未設定ならテナント内のどの購入でもスキップ（Postgres 版の product_id is null と同じ）",
  );
  assert.equal(shouldSkipDelivery({ ...base, targetProductId: null }), false, "対象未設定かつ未購入なら送る");
  assert.equal(shouldSkipDelivery({ ...base, skipIfPurchased: false, purchasedProductIds: ["p1"] }), false, "スキップ設定なし");
  assert.equal(
    shouldSkipDelivery({ ...base, scenarioHasPurchaseTrigger: true, purchasedProductIds: ["p1"] }),
    false,
    "購入起点シナリオでは購入済みスキップを適用しない",
  );
});

test("toQueueTimestamp の文字列比較は時刻比較と一致する（インデックス比較の前提）", () => {
  const times = [
    new Date("2026-01-31T23:59:59.999Z"),
    new Date("2026-02-01T00:00:00.000Z"),
    new Date("2026-09-14T12:00:00.001Z"),
    new Date("2026-10-01T09:30:00.500Z"),
  ];
  const asStrings = times.map(toQueueTimestamp);
  const sorted = [...asStrings].sort();
  assert.deepEqual(asStrings, sorted);
});
