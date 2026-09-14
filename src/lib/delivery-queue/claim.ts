/**
 * issue #10 [移行 P4]: 配信キュー deliveries を D1 (SQLite) へ切り出すための
 * キュー操作エンジン。Postgres 版 claim_deliveries RPC
 * (supabase/migrations/20260901020000) のうち「キューの状態遷移」を TypeScript へ移植した。
 *
 * Postgres 版との対応:
 *   - スタック復旧 (processing のまま10分) → recoverStuckDeliveries
 *   - claim (FOR UPDATE SKIP LOCKED)       → claimDueDeliveries
 *       D1 は単一 writer で書き込みが直列実行されるため SKIP LOCKED は不要。
 *       1本の UPDATE ... RETURNING が原子的に「候補選択＋processing 化」を行う。
 *   - 送信条件フィルタ (解除済み/停止/購入済みスキップ) → shouldSkipDelivery + markDeliveriesSkipped
 *       readers / scenario_readers / step_messages / scenarios / purchases は P4 時点で
 *       Supabase 側に残るため、SQL の join では書けない。Worker が Supabase から
 *       判定材料を引いたうえで、この純関数で判定する。
 *   - 送信結果の反映 → markDeliverySent / releaseDeliveryFailure
 *
 * DB は QueueDb インターフェイス越しに触る。本番は D1（prepare().bind().all()/run() を
 * 薄く包む）、テストは node:sqlite。SQL は両方で動く SQLite 方言のみを使う。
 *
 * 時刻はすべて UTC の ISO 8601 文字列（toQueueTimestamp）。このフォーマットは
 * 文字列比較が時刻比較と一致するため、scheduled_at <= ? が (status, scheduled_at)
 * インデックスの効く単純比較になる（cloudflare/d1/migrations/0001_deliveries.sql 参照）。
 */

/** 最大送信試行回数。超えたら failed で打ち止め（Postgres 版 RPC と同じ値）。 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** processing のままこの分数を超えた行を「スタック」とみなして復旧する（Postgres 版と同じ値）。 */
export const PROCESSING_TIMEOUT_MINUTES = 10;

/**
 * 1回の claim で取る最大件数。Postgres 版 RPC の batch_limit 上限と同じ 500。
 * 旧値の根拠（要件定義書 7.5 #4、Edge Function の実行時間制限）は Workers 移行で
 * CPU 制限が変わるため消えるが、Resend Batch API 100通×5回・D1 の1クエリ結果サイズを
 * 考えると引き上げは実測後でよい（docs/移行P4-配信キューD1切り出し.md 参照）。
 */
export const DELIVERY_CLAIM_MAX_BATCH = 500;

/** error_message に格納する最大長（Edge Function の .slice(0, 500) と同じ）。 */
export const ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * D1 は1クエリあたりのバインドパラメータを最大100個に制限している（Cloudflare D1 Limits）。
 * `id in (?, ?, ...)` のようにID列を展開するクエリはこの上限でチャンクする必要がある。
 */
export const D1_MAX_BIND_PARAMS = 100;

type SqlParam = string | number | null;

/**
 * D1 と node:sqlite の両方を薄く包む最小インターフェイス。
 * D1 なら: all = (sql, p) => db.prepare(sql).bind(...p).all().then(r => r.results),
 *          run = (sql, p) => db.prepare(sql).bind(...p).run()
 */
export interface QueueDb {
  all<T>(sql: string, params: readonly SqlParam[]): Promise<T[]>;
  run(sql: string, params: readonly SqlParam[]): Promise<void>;
}

/** claim が返すキュー行。メール本文などの表示素材は Supabase 側から別途引く。 */
export interface ClaimedDelivery {
  id: string;
  tenant_id: string;
  scenario_reader_id: string;
  step_message_id: string;
  reader_id: string;
  scheduled_at: string;
  /** claim によるインクリメント後の値（= 今回が何回目の試行か）。 */
  attempt_count: number;
}

/** D1 に格納する時刻表現。UTC・ミリ秒3桁固定の ISO 8601（文字列比較 = 時刻比較）。 */
export function toQueueTimestamp(date: Date): string {
  return date.toISOString();
}

function minutesBefore(date: Date, minutes: number): string {
  return toQueueTimestamp(new Date(date.getTime() - minutes * 60_000));
}

/**
 * processing のまま PROCESSING_TIMEOUT_MINUTES を超えた行を復旧する。
 * attempt_count が上限に達していれば failed で打ち止め、まだなら queued に戻して再試行させる。
 * （Postgres 版 claim_deliveries の冒頭 UPDATE と同じ判定。processing_started_at が null の
 * 行は scheduled_at を代わりの基準にする点も同じ。）
 */
export async function recoverStuckDeliveries(db: QueueDb, now: Date): Promise<void> {
  const cutoff = minutesBefore(now, PROCESSING_TIMEOUT_MINUTES);
  await db.run(
    `update deliveries set
       status = case when attempt_count >= ? then 'failed' else 'queued' end,
       error_message = case when attempt_count >= ? then 'processing timeout after maximum retries' else error_message end,
       processing_started_at = null
     where status = 'processing'
       and ((processing_started_at is not null and processing_started_at < ?)
         or (processing_started_at is null and scheduled_at < ?))`,
    [MAX_DELIVERY_ATTEMPTS, MAX_DELIVERY_ATTEMPTS, cutoff, cutoff],
  );
}

/**
 * claim 対象を選ぶ SELECT 文（targetDeliveryId 未指定時）。
 * `test/unit/delivery-queue-claim.test.ts` の EXPLAIN QUERY PLAN 検証はこの定数に対して行う。
 * `order by` はここでは「候補として選ぶ行」を決めるだけで、行の返却順は保証しない
 * （claimDueDeliveries 側で TypeScript が返却行を並べ替える）。
 */
export const CLAIM_CANDIDATE_SELECT_SQL = `select id from deliveries
       where status = 'queued' and scheduled_at <= ?
       order by scheduled_at, id
       limit ?`;

/**
 * 期限が来た queued 行を batchLimit 件まで claim し、processing にして返す。
 *
 * 1本の UPDATE ... RETURNING で「候補の選択」と「processing 化」を同時に行う。
 * D1 の書き込みは直列なので、複数の cron 実行が重なっても同じ行を二重に claim できない
 * （Postgres で FOR UPDATE SKIP LOCKED が担っていた排他と同等）。
 *
 * SQLite / D1 の `RETURNING` は返却行の順序を保証しない（サブクエリ内の `order by` は
 * 「どの行を選ぶか」にしか効かない）。Postgres 版 RPC は末尾に独立した
 * `order by delivery.scheduled_at, delivery.id` を持っていたが、その保証はこの移植では
 * SQL 側では再現できないため、ここで TypeScript 側で明示的に scheduled_at, id 順に並べ直す。
 */
export async function claimDueDeliveries(
  db: QueueDb,
  now: Date,
  batchLimit: number = DELIVERY_CLAIM_MAX_BATCH,
  targetDeliveryId: string | null = null,
): Promise<ClaimedDelivery[]> {
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > DELIVERY_CLAIM_MAX_BATCH) {
    throw new Error(`batch_limit must be between 1 and ${DELIVERY_CLAIM_MAX_BATCH}`);
  }

  const claimTime = toQueueTimestamp(now);
  const targetFilter = targetDeliveryId === null ? "" : "and id = ?";
  const params: SqlParam[] =
    targetDeliveryId === null
      ? [claimTime, claimTime, batchLimit]
      : [claimTime, claimTime, targetDeliveryId, batchLimit];

  const claimed = await db.all<ClaimedDelivery>(
    `update deliveries set
       status = 'processing',
       processing_started_at = ?,
       attempt_count = attempt_count + 1,
       error_message = null
     where id in (
       select id from deliveries
       where status = 'queued' and scheduled_at <= ? ${targetFilter}
       order by scheduled_at, id
       limit ?
     )
     returning id, tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at, attempt_count`,
    params,
  );

  return claimed.sort((a, b) => {
    if (a.scheduled_at !== b.scheduled_at) {
      return a.scheduled_at < b.scheduled_at ? -1 : 1;
    }
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * 送信成功を記録する。`status = 'processing'` の行にしか効かないため、
 * 二重に呼んでも sent の行を上書きしない（Edge Function の .eq("status","processing") と同じ）。
 */
export async function markDeliverySent(
  db: QueueDb,
  deliveryId: string,
  resendMessageId: string | null,
  now: Date,
): Promise<void> {
  await db.run(
    `update deliveries set status = 'sent', sent_at = ?, resend_message_id = ?, processing_started_at = null
     where id = ? and status = 'processing'`,
    [toQueueTimestamp(now), resendMessageId, deliveryId],
  );
}

/**
 * 送信失敗を記録する。attempt_count が上限に達していれば failed、まだなら queued に戻す
 * （次の cron で再試行される）。error_message は 500 文字で切り詰める。
 */
export async function releaseDeliveryFailure(db: QueueDb, deliveryId: string, errorMessage: string): Promise<void> {
  await db.run(
    `update deliveries set
       status = case when attempt_count >= ? then 'failed' else 'queued' end,
       processing_started_at = null,
       error_message = ?
     where id = ? and status = 'processing'`,
    [MAX_DELIVERY_ATTEMPTS, errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH), deliveryId],
  );
}

/**
 * 送信条件を満たさなかった行を skipped にする（Postgres 版の 'delivery condition not met' と同じ文言）。
 *
 * D1_MAX_BIND_PARAMS（100）件ずつチャンクして複数回 UPDATE を撃つ。DELIVERY_CLAIM_MAX_BATCH（500）件を
 * 一度に claim できるため、スキップ対象が101件以上になるケースは普通に起こりうる。チャンク化しないと
 * D1 で「too many SQL variables」相当のエラーになり、該当行が processing のまま滞留する。
 */
export async function markDeliveriesSkipped(db: QueueDb, deliveryIds: readonly string[]): Promise<void> {
  if (deliveryIds.length === 0) return;
  for (let offset = 0; offset < deliveryIds.length; offset += D1_MAX_BIND_PARAMS) {
    const chunk = deliveryIds.slice(offset, offset + D1_MAX_BIND_PARAMS);
    const placeholders = chunk.map(() => "?").join(", ");
    await db.run(
      `update deliveries set status = 'skipped', processing_started_at = null,
         error_message = 'delivery condition not met'
       where status = 'processing' and id in (${placeholders})`,
      [...chunk],
    );
  }
}

/** shouldSkipDelivery の判定材料。Worker が Supabase から引いてくる。 */
export interface DeliveryConditionInput {
  /** readers.unsubscribed_at が非 null か。 */
  readerUnsubscribed: boolean;
  /** scenario_readers.status。 */
  enrollmentStatus: string;
  /** step_messages.skip_if_purchased。 */
  skipIfPurchased: boolean;
  /** シナリオの funnel が trigger_type = 'purchase' か（購入起点シナリオはスキップ判定の対象外）。 */
  scenarioHasPurchaseTrigger: boolean;
  /**
   * シナリオの funnel に紐づく対象商品。null は「対象商品が未設定」
   * （= scenario.funnel_id が null、または funnel に product_id 設定なし）を意味し、
   * その場合はテナント内のいずれかの購入でスキップする（Postgres 版と同じ意味論）。
   */
  targetProductId: string | null;
  /** この読者がテナント内で購入済みの product_id 一覧。 */
  purchasedProductIds: readonly string[];
}

/**
 * 送信条件フィルタ。Postgres 版 claim_deliveries の skipped 判定
 * （解除済み / 停止・完了 / 購入済みスキップ）を純関数として移植したもの。
 * true なら送信せず skipped にする。
 */
export function shouldSkipDelivery(input: DeliveryConditionInput): boolean {
  if (input.readerUnsubscribed) return true;
  if (input.enrollmentStatus === "stopped" || input.enrollmentStatus === "completed") return true;

  if (!input.skipIfPurchased) return false;
  // 購入起点シナリオでは「購入済みだから送らない」は成り立たない（購入がトリガーそのもの）。
  if (input.scenarioHasPurchaseTrigger) return false;

  if (input.targetProductId === null) return input.purchasedProductIds.length > 0;
  return input.purchasedProductIds.includes(input.targetProductId);
}
