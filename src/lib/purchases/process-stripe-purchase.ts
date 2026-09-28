/**
 * issue #29 [移行 P5]: Postgres 版 `process_stripe_purchase`
 * (supabase/migrations/20260815020000_process_stripe_purchase.sql) の TS 移植。
 *
 * 呼び出し方針（ADR: docs/移行P5-ADR-トランザクション設計.md 方式A）:
 *   - この関数はテナント単位の Durable Object の中から、`src/lib/d1/tenant-db.ts` の
 *     `createTenantDb(executor, tenantId)` が返す `TenantDb` 越しにしか DB を触らない。
 *     生の D1Executor / D1Database を直接持ち出さない。
 *   - DO がテナントごとに書き込みを直列化するため、この関数自身は排他制御をしない
 *     （Postgres 版の FOR UPDATE 相当は DO の実行モデルが肩代わりする）。
 *
 * Postgres 版との既知の差分（判断の記録。ハンドオフファイルにも書く）:
 *   1. 実行順序を「読む・判断する（例外を投げうる）→ 書く（例外を投げない）」の
 *      2フェーズに並べ替えている。Postgres 版はPL/pgSQL関数1本が丸ごと1トランザクションに
 *      乗るため、関数の途中（例: reader_labels 付与後）で例外が起きても全体がロールバックされる。
 *      D1 にはその保証が無く（tenant-db.ts はテナント境界の強制だけを担い、複数文をまたぐ
 *      原子性は提供しない — batch() の追加は tenant-db.ts の変更になるためこの issue の
 *      スコープ外）、Postgres 版と同じ書き込み順のまま移植すると「reader_labels を
 *      付与した直後に post-purchase scenario not found で例外」のようなケースで
 *      部分的な書き込みが残ってしまう。全ての「存在しなければ例外を投げる」判定を
 *      書き込み開始前に終わらせることで、書き込みフェーズに入ってからは
 *      （D1自体の障害を除き）例外で処理が止まらないようにしている。
 *   2. 上記の並べ替えをもってしても、書き込みフェーズの複数文はまだ原子的ではない
 *      （D1 の1文ごとに auto-commit）。DO はテナントごとに直列実行されるため
 *      同一テナント内の別呼び出しと競合することは無いが、書き込み文の間で
 *      D1 自体が失敗した場合（ネットワーク断など）は部分的な書き込みが残りうる。
 *      真の原子性が必要になった場合は tenant-db.ts に batch() 相当を追加する
 *      判断が要る（別issueで検討。ガードロジックは変えず、同じ prepare() 検査を
 *      複数文に適用する形を想定）。
 */

import type { TenantDb } from "../d1/tenant-db.ts";

export interface ProcessStripePurchaseInput {
  readonly productId: string;
  readonly stripeSessionId: string;
  /** 呼び出し側で小文字化済みであることを期待しない。ここで lower() する（Postgres 版と同じ）。 */
  readonly buyerEmail: string;
  /** 空文字列は Postgres 版の nullif(buyer_name, '') と同様 null 扱いにする。 */
  readonly buyerName: string | null;
  readonly paidAmount: number | null;
  /** UTC の ISO 8601 文字列。Stripe イベントの `created` から呼び出し側が変換する。 */
  readonly purchasedAt: string;
  /** 新規 reader 作成時にのみ使う。既存 reader のトークンは上書きしない（Postgres 版と同じ）。 */
  readonly accessToken: string;
  readonly unsubscribeToken: string;
}

interface ProductRow {
  id: string;
  post_purchase_scenario_id: string | null;
  post_purchase_label_id: string | null;
}

interface ScenarioRow {
  id: string;
  funnel_id: string | null;
}

interface FunnelRow {
  id: string;
  deadline_hours: number;
}

interface StepMessageRow {
  id: string;
  delay_minutes: number;
  send_at_hour: number | null;
}

/** ISO 8601 (UTC) 文字列を Asia/Tokyo の "yyyy-MM-dd" に変換する。 */
function jstDatePart(isoUtc: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA は yyyy-MM-dd 形式を返す（ロケール依存の区切り文字違いを避けるため固定で使う）。
  return formatter.format(new Date(isoUtc));
}

/**
 * Asia/Tokyo（UTC+9、夏時間なし）の壁時計時刻 "yyyy-MM-ddTHH:mm:ss" を UTC の ISO 文字列に変換する。
 * src/lib/csv/timezone.ts の jstDatetimeLocalToUtcIso と同じ変換だが、あちらは
 * `<input type="datetime-local">` 由来の値専用の命名になっているため、ここでは
 * ドメイン（配信スケジュール計算）に沿った名前で薄くラップして重複実装を避ける。
 */
function jstWallClockToUtcIso(year: number, month: number, day: number, hour: number): string {
  const utcMs = Date.UTC(year, month - 1, day, hour, 0, 0) - 9 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

/**
 * step_message 1件の配信予定時刻を計算する。Postgres 版の CASE式と同じ規則:
 *   - send_at_hour が null: registered_at + delay_minutes（時刻そのまま）。
 *   - send_at_hour がある: (registered_at + delay_minutes) を Asia/Tokyo の日付に落とし、
 *     その日の send_at_hour:00:00 (Asia/Tokyo) を UTC に変換する。
 */
export function computeStepScheduledAt(registeredAtIso: string, delayMinutes: number, sendAtHour: number | null): string {
  const base = new Date(new Date(registeredAtIso).getTime() + delayMinutes * 60_000);
  if (sendAtHour === null) return base.toISOString();
  const [year, month, day] = jstDatePart(base.toISOString()).split("-").map(Number);
  return jstWallClockToUtcIso(year, month, day, sendAtHour);
}

function addHoursIso(isoUtc: string, hours: number): string {
  return new Date(new Date(isoUtc).getTime() + hours * 60 * 60 * 1000).toISOString();
}

export class ProductNotFoundError extends Error {
  constructor() {
    super("product not found");
    this.name = "ProductNotFoundError";
  }
}

export class PostPurchaseScenarioNotFoundError extends Error {
  constructor() {
    super("post-purchase scenario not found");
    this.name = "PostPurchaseScenarioNotFoundError";
  }
}

export class ActivePurchaseFunnelNotFoundError extends Error {
  constructor() {
    super("active purchase funnel not found");
    this.name = "ActivePurchaseFunnelNotFoundError";
  }
}

/**
 * Stripe Checkout 完了1件を処理する。Postgres 版と同じ意味論:
 *   - 同じ stripe_session_id の再送は無視する（何も書かない）。
 *   - reader は (tenant_id, email) で upsert。名前は既存値が null のときだけ埋める。
 *     アクセストークン・購読解除トークンは新規作成時にしか設定しない。
 *   - 商品に post_purchase_label_id があればラベルを付与する。
 *   - 商品に post_purchase_scenario_id があれば、対応する active な購入トリガー funnel を
 *     見つけて読者をシナリオへ登録し、シナリオの各ステップの配信を deliveries に積む。
 */
export async function processStripePurchase(db: TenantDb, input: ProcessStripePurchaseInput): Promise<void> {
  // --- 読む・判断するフェーズ。ここでの例外は何も書き込む前に発生する。 ---
  const alreadyProcessed = await db.get<{ id: string }>(
    "select id from purchases where tenant_id = :tenant and stripe_session_id = ?",
    [input.stripeSessionId],
  );
  if (alreadyProcessed) return;

  const product = await db.get<ProductRow>(
    "select id, post_purchase_scenario_id, post_purchase_label_id from products where tenant_id = :tenant and id = ?",
    [input.productId],
  );
  if (!product) throw new ProductNotFoundError();

  let scenario: ScenarioRow | undefined;
  let funnel: FunnelRow | undefined;
  let steps: StepMessageRow[] = [];
  if (product.post_purchase_scenario_id !== null) {
    scenario = await db.get<ScenarioRow>(
      "select id, funnel_id from scenarios where tenant_id = :tenant and id = ? and is_active = 1",
      [product.post_purchase_scenario_id],
    );
    if (!scenario) throw new PostPurchaseScenarioNotFoundError();

    funnel = await db.get<FunnelRow>(
      `select id, deadline_hours from funnels
       where tenant_id = :tenant and id = ? and trigger_type = 'purchase' and product_id = ? and is_active = 1`,
      [scenario.funnel_id, input.productId],
    );
    if (!funnel) throw new ActivePurchaseFunnelNotFoundError();

    steps = await db.all<StepMessageRow>(
      "select id, delay_minutes, send_at_hour from step_messages where tenant_id = :tenant and scenario_id = ?",
      [scenario.id],
    );
  }

  // --- 書くフェーズ。ここから先は「存在しないので例外」という分岐が起きないことを
  //     上のフェーズで保証済み。D1自体の障害以外で処理が中断することは無い。 ---
  const normalizedEmail = input.buyerEmail.trim().toLowerCase();
  const normalizedName = input.buyerName === "" ? null : input.buyerName;

  const reader = await db.get<{ id: string }>(
    `insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at)
     values (?, :tenant, ?, ?, ?, ?, ?)
     on conflict (tenant_id, email) do update set name = coalesce(readers.name, excluded.name)
     returning id`,
    [crypto.randomUUID(), normalizedEmail, normalizedName, input.accessToken, input.unsubscribeToken, input.purchasedAt],
  );
  if (!reader) throw new Error("reader upsert did not return a row");

  const purchase = await db.get<{ id: string }>(
    `insert into purchases (id, tenant_id, reader_id, product_id, stripe_session_id, amount, purchased_at)
     values (?, :tenant, ?, ?, ?, ?, ?)
     on conflict (stripe_session_id) do nothing
     returning id`,
    [crypto.randomUUID(), reader.id, input.productId, input.stripeSessionId, input.paidAmount, input.purchasedAt],
  );
  // 直前の存在チェックとここまでの間に、同じ stripe_session_id を別の呼び出しが
  // 先に処理し終えていた場合（DO の直列化を越えてテナント外から同時に叩かれた等）。
  // Postgres 版の `if not found then return` と同じ扱いにする。
  if (!purchase) return;

  if (product.post_purchase_label_id !== null) {
    await db.run(
      `insert into reader_labels (tenant_id, reader_id, label_id, granted_at)
       values (:tenant, ?, ?, ?)
       on conflict (reader_id, label_id) do nothing`,
      [reader.id, product.post_purchase_label_id, input.purchasedAt],
    );
  }

  if (!scenario || !funnel) return;

  const deadlineAt = addHoursIso(input.purchasedAt, funnel.deadline_hours);
  const enrollment = await db.get<{ id: string }>(
    `insert into scenario_readers (id, tenant_id, reader_id, scenario_id, registration_path, registered_at, deadline_at)
     values (?, :tenant, ?, ?, 'stripe', ?, ?)
     on conflict (reader_id, scenario_id) do update set reader_id = excluded.reader_id
     returning id`,
    [crypto.randomUUID(), reader.id, scenario.id, input.purchasedAt, deadlineAt],
  );
  if (!enrollment) throw new Error("scenario_readers upsert did not return a row");

  if (steps.length === 0) return;

  const valueTuples = steps.map(() => "(?, :tenant, ?, ?, ?, ?)").join(", ");
  const params = steps.flatMap((step) => [
    crypto.randomUUID(),
    enrollment.id,
    step.id,
    reader.id,
    computeStepScheduledAt(input.purchasedAt, step.delay_minutes, step.send_at_hour),
  ]);
  await db.run(
    `insert into deliveries (id, tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at)
     values ${valueTuples}
     on conflict (scenario_reader_id, step_message_id) do nothing`,
    params,
  );
}
