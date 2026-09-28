// issue #29 [移行 P5] レビュー 🟡-7: workers/tenant-do/src/index.ts の
// TenantDurableObject.processStripePurchase から Cloudflare型非依存部分を切り出した
// src/lib/d1/process-stripe-purchase-rpc.ts のテスト。
//
// workers/tenant-do は cloudflare:workers に依存しておりルートの npm test 対象外
// （README 参照）のため、DOクラス自体はテストできない。ここでは「doName から
// テナントIDを解決 → createTenantDb → processStripePurchase を実行する」という
// “配線” 部分を直接テストすることで、その穴を埋める。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { D1Executor } from "../../src/lib/d1/tenant-db.ts";
import { runProcessStripePurchaseRpc } from "../../src/lib/d1/process-stripe-purchase-rpc.ts";
import type { ProcessStripePurchaseInput } from "../../src/lib/purchases/process-stripe-purchase.ts";

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

function seedProduct(db: DatabaseSync, tenantId: string, productId: string) {
  db.prepare(
    "insert into products (id, tenant_id, name, stripe_price_id, post_purchase_scenario_id, post_purchase_label_id, created_at) values (?, ?, ?, ?, ?, ?, ?)",
  ).run(productId, tenantId, "product", "price_x", null, null, "2026-09-01T00:00:00.000Z");
}

function baseInput(overrides: Partial<ProcessStripePurchaseInput> = {}): ProcessStripePurchaseInput {
  return {
    productId: "prod-1",
    stripeSessionId: "sess-1",
    buyerEmail: "buyer@example.com",
    buyerName: "Buyer",
    paidAmount: 1000,
    purchasedAt: "2026-09-14T03:00:00.000Z",
    accessToken: "access-1",
    unsubscribeToken: "unsub-1",
    ...overrides,
  };
}

test("runProcessStripePurchaseRpc: doName から解決したテナントIDだけに書き込む（配線の検証。レビュー 🟡-7）", async () => {
  const { db, executor } = createDb();
  // products.id はテナント単位ではなくグローバルな主キーなので、2テナント分のフィクスチャは
  // 別 id にする（process-stripe-purchase.test.ts の越境テストと同じ理由）。
  seedProduct(db, "tenant-a", "prod-1-a");
  seedProduct(db, "tenant-b", "prod-1-b");

  const result = await runProcessStripePurchaseRpc(executor, "tenant-a", baseInput({ productId: "prod-1-a" }));

  assert.equal(result.ok, true);
  const readersA = db.prepare("select * from readers where tenant_id = 'tenant-a'").all();
  assert.equal(readersA.length, 1, "doName=tenant-a のときは tenant-a にだけ書き込む");
  const readersB = db.prepare("select * from readers where tenant_id = 'tenant-b'").all();
  assert.equal(readersB.length, 0, "tenant-b には何も書き込まれない（もし固定文字列に差し替えられていたらここで検出できる）");
});

test("runProcessStripePurchaseRpc: doName が null なら DB に触れずに ok:false を返す（レビュー 🟡-7）", async () => {
  const { db, executor } = createDb();

  const result = await runProcessStripePurchaseRpc(executor, null, baseInput());

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /idFromName\(tenantId\)/);
  const readerCount = db.prepare("select count(*) as c from readers").get() as { c: number };
  assert.equal(readerCount.c, 0);
});

test("runProcessStripePurchaseRpc: 業務ロジックの例外は投げずに ok:false + errorName で返す", async () => {
  const { executor } = createDb();
  // prod-1 を作らずに呼ぶ → ProductNotFoundError。

  const result = await runProcessStripePurchaseRpc(executor, "tenant-a", baseInput());

  assert.equal(result.ok, false);
  assert.equal(result.errorName, "ProductNotFoundError");
});
