/**
 * issue #29 [移行 P5]: Postgres 版 `register_reader`
 * (supabase/migrations/20260902020000_register_reader_variable_conflict.sql が最終版。
 * 初版 20260815010000 からの一連の migration の到達点) の TS 移植。
 *
 * 呼び出し方針（ADR: docs/移行P5-ADR-トランザクション設計.md 方式A）は
 * process-stripe-purchase.ts と同じ:
 *   - この関数はテナント単位の Durable Object の中から `TenantDb`（tenant-db.ts の
 *     createTenantDb が返す）越しにしか DB を触らない。
 *   - DO がテナントごとに書き込みを直列化するため、この関数自身は排他制御をしない
 *     （呼び出し側 = workers/tenant-do の RPC メソッドが ctx.blockConcurrencyWhile() で
 *     この関数の呼び出し全体を囲むことで直列化する。process-stripe-purchase.ts と同じ構造）。
 *
 * 外部作用（1通目メール送信）についての注意（ADR「外部作用にのみ方式Bの冪等キーを併用」）:
 *   この関数自身は Resend を呼ばない。Postgres 版と同じく「1通目を status='processing' で
 *   キューに積み、送信に使う subject/body/initial_delivery_id を返す」までがこの関数の責務で、
 *   実際の送信は呼び出し側（現行 src/app/api/registrations/route.ts と同じ役割を担う、
 *   D1版の呼び出し元 — このIssueのスコープ外）が行う。送信自体の冪等性は既存の
 *   Resend Idempotency-Key の仕組み（現行 dispatch と同じ）に委ねる。
 *   この関数が担う「二重登録・二重送信の防止」は次の2点:
 *     1. 登録の冪等性: readers は (tenant_id, email) の UNIQUE、scenario_readers は
 *        (reader_id, scenario_id) の UNIQUE で保証（Postgres 版と同じ）。
 *     2. 二重送信の防止: 同じ (reader, scenario) への2回目以降の呼び出しは
 *        `hadEnrollment` が true になり、(a) 返り値の subject/body/initialDeliveryId は
 *        必ず null になる（呼び出し側はこれを見て送信しない）、(b) 1通目の delivery を
 *        再送キューへ戻す（status を 'queued' に戻す）のは RESEND_COOLDOWN_MS
 *        （10分。Postgres 版の `resend_cooldown` と同じ）が経過したときだけ、という
 *        2段構えで守る（詳細は下記コメントと関数本体を参照）。
 *
 * Postgres 版との既知の差分（判断の記録。ハンドオフファイルにも書く）:
 *   1. process-stripe-purchase.ts と同じ理由で「読む・判断する（例外を投げうる）→
 *      書く（例外を投げない）」の2フェーズに並べ替えている。Postgres 版は
 *      `registration_paths` の探索（'registration path not found' で例外を投げうる）が
 *      readers / scenario_readers への書き込みの**後**にあり、関数全体が1トランザクションに
 *      乗ることで例外時に全部ロールバックされる前提になっている。D1 にはその保証が無いため、
 *      この探索を書き込みフェーズの前に移動した。
 *   2. 上記の並べ替えをもってしても、書き込みフェーズの複数文(readers upsert /
 *      scenario_readers upsert / reader_labels insert / deliveries insert / deliveries
 *      requeue update)はまだ原子的ではない（process-stripe-purchase.ts の差分2と同じ理由・
 *      同じ限界）。
 *   3. Postgres 版の `#variable_conflict use_column` プラグマは、`returns table` の
 *      列名（email, reader_id 等）が PL/pgSQL の OUT 変数を兼ねることで
 *      `on conflict (tenant_id, email)` 等が曖昧になる事故（20260902020000 で修正済み）
 *      への対処だった。TS には OUT 変数という概念自体が無いため、この問題は最初から
 *      発生しない（移植時に再現・再修正すべき対象ではない）。
 *   4. `buyerEmail` 相当の `input.email` は `.trim().toLowerCase()`、Postgres 版は
 *      `lower()` のみで trim していない（process-stripe-purchase.ts の差分5と同じ判断）。
 *   5. Postgres 版は `readers.created_at` / `scenario_readers.registered_at` /
 *      `reader_labels.granted_at` をどれも列指定せず DB 既定 (`now()`) に任せている。
 *      D1 の対応列にはデフォルトが無い（0002/0003 マイグレーション参照）ため、
 *      `input.now` を明示的に入れる。関数内で `now()` が呼ばれるたびに違う値になりうる
 *      Postgres 版と異なり、`input.now` は呼び出し全体で単一の値を使う
 *      （Postgres の関数内 `now()` はトランザクション開始時刻で安定するため、
 *      むしろ Postgres 版の意味論に忠実な選択）。
 */

import type { TenantDb } from "../d1/tenant-db.ts";
import { D1_MAX_BIND_PARAMS } from "../delivery-queue/claim.ts";
import { addHoursIso, computeStepScheduledAt } from "../purchases/process-stripe-purchase.ts";

/** Postgres 版の `resend_cooldown constant interval := interval '10 minutes'` と同じ。 */
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

export interface RegisterReaderInput {
  readonly funnelSlug: string;
  /** 呼び出し側で小文字化済みであることを期待しない。ここで trim + lower する。 */
  readonly email: string;
  /** 空文字列は Postgres 版の nullif(reader_name, '') と同様 null 扱いにする。 */
  readonly name: string | null;
  readonly registrationPath: string | null;
  /** 新規 reader 作成時にのみ使う。既存 reader のトークンは上書きしない（Postgres 版と同じ）。 */
  readonly accessToken: string;
  readonly unsubscribeToken: string;
  /**
   * UTC の ISO 8601 文字列。Postgres 版の `now()` に相当する、この呼び出し全体で
   * 単一の基準時刻。readers.created_at / scenario_readers.registered_at /
   * reader_labels.granted_at の新規値、deadline_at の計算基準、再送クールダウンの
   * 判定基準として使う。
   */
  readonly now: string;
}

export interface RegisterReaderResult {
  readonly email: string;
  readonly name: string | null;
  readonly accessToken: string;
  readonly unsubscribeToken: string;
  readonly funnelSlug: string;
  readonly deadlineAt: string;
  /** 新規登録（かつ購入済みスキップ非該当）のときのみ非null。1通目の即時送信に使う。 */
  readonly subject: string | null;
  readonly body: string | null;
  readonly initialDeliveryId: string | null;
  readonly productId: string | null;
  readonly readerId: string;
  /** 1通目送信後にラベル付与する対象。subject 等と同じ条件でのみ非null。 */
  readonly initialGrantLabelId: string | null;
}

interface FunnelRow {
  id: string;
  slug: string;
  product_id: string | null;
  deadline_hours: number;
}

interface ScenarioRow {
  id: string;
}

interface InitialStepRow {
  id: string;
  subject: string;
  body: string;
  grant_label_id: string | null;
  skip_if_purchased: number;
}

interface StepRow {
  id: string;
  delay_minutes: number;
  send_at_hour: number | null;
}

interface ReaderRow {
  id: string;
  email: string;
  name: string | null;
  access_token: string;
  unsubscribe_token: string;
  unsubscribed_at: string | null;
}

interface EnrollmentRow {
  id: string;
  registered_at: string;
  deadline_at: string;
}

export class ActiveRegistrationFunnelNotFoundError extends Error {
  constructor() {
    super("active registration funnel not found");
    this.name = "ActiveRegistrationFunnelNotFoundError";
  }
}

export class ActiveScenarioNotFoundError extends Error {
  constructor() {
    super("active scenario not found");
    this.name = "ActiveScenarioNotFoundError";
  }
}

export class RegistrationPathNotFoundError extends Error {
  constructor() {
    super("registration path not found");
    this.name = "RegistrationPathNotFoundError";
  }
}

/**
 * 読者登録1件を処理する。Postgres 版と同じ意味論:
 *   - funnel を slug から解決（trigger_type='registration' かつ active）。
 *   - そのファネルの active なシナリオを1つ解決（created_at, id の昇順で最初の1件）。
 *   - registration_path が指定されていれば、対応する registration_paths 行を要求する
 *     （無ければ例外。存在すればラベル付与に使う label_id を得る。null もありうる）。
 *   - reader は (tenant_id, email) で upsert。名前は既存値が null のときだけ埋める。
 *     アクセストークン・購読解除トークンは新規作成時にしか設定しない。
 *   - 「既にこの (reader, scenario) へ登録済みか」を upsert 前に判定する（hadEnrollment）。
 *   - scenario_readers を (reader_id, scenario_id) で upsert。新規時のみ deadline_at を
 *     計算して入れる（conflict 時は既存値のまま — Postgres 版の on conflict do update set
 *     reader_id = excluded.reader_id と同じ、registered_at/deadline_at は更新しない）。
 *   - registration_path のラベルがあれば reader_labels に付与（二重付与はしない）。
 *   - 購読解除済み (unsubscribed_at is not null) の reader にはキューを一切積まない。
 *   - 「購入済みには1通目を送らない」(要件定義書 4.3-4): 1通目の step_message に
 *     skip_if_purchased があり、かつ対象商品（funnel.product_id。未設定ならテナント内の
 *     いずれか）を既に購入済みなら、1通目は status='skipped' で積む。
 *   - 新規登録（hadEnrollment=false）かつ購入済みスキップ非該当のときだけ、1通目の
 *     subject/body/initialDeliveryId/initialGrantLabelId を返す（呼び出し側が即時送信する）。
 *   - 既に登録済み(hadEnrollment=true)の再登録は、1通目の delivery が
 *     'sent'|'queued'|'failed'|'skipped' のいずれかで、直近の送信/予約から
 *     RESEND_COOLDOWN_MS 以上経っていれば 'queued' に積み直す（連投抑止つきの再送）。
 *     このとき subject 等は返さない（呼び出し側は送信せず、通常の配信バッチに委ねる）。
 */
export async function registerReader(db: TenantDb, input: RegisterReaderInput): Promise<RegisterReaderResult> {
  // --- 読む・判断するフェーズ。ここでの例外は何も書き込む前に発生する。 ---
  const funnel = await db.get<FunnelRow>(
    `select id, slug, product_id, deadline_hours from funnels
     where tenant_id = :tenant and slug = ? and trigger_type = 'registration' and is_active = 1`,
    [input.funnelSlug],
  );
  if (!funnel) throw new ActiveRegistrationFunnelNotFoundError();

  const scenario = await db.get<ScenarioRow>(
    `select id from scenarios where tenant_id = :tenant and funnel_id = ? and is_active = 1
     order by created_at, id limit 1`,
    [funnel.id],
  );
  if (!scenario) throw new ActiveScenarioNotFoundError();

  // Postgres 版はこの探索を readers / scenario_readers への書き込みの後に行うが、
  // ここでは「読む・判断する」フェーズにまとめて、書き込み開始前に例外を確定させる
  // （既知の差分1）。
  let pathLabelId: string | null = null;
  if (input.registrationPath !== null) {
    const path = await db.get<{ label_id: string | null }>(
      "select label_id from registration_paths where tenant_id = :tenant and funnel_id = ? and path = ?",
      [funnel.id, input.registrationPath],
    );
    if (!path) throw new RegistrationPathNotFoundError();
    pathLabelId = path.label_id;
  }

  const initialStep = await db.get<InitialStepRow>(
    `select id, subject, body, grant_label_id, skip_if_purchased from step_messages
     where tenant_id = :tenant and scenario_id = ? and delay_minutes = 0
     order by position, id limit 1`,
    [scenario.id],
  );

  const steps = await db.all<StepRow>(
    "select id, delay_minutes, send_at_hour from step_messages where tenant_id = :tenant and scenario_id = ?",
    [scenario.id],
  );

  // --- 書くフェーズ。ここから先は「存在しないので例外」という分岐が起きないことを
  //     上のフェーズで保証済み。D1自体の障害以外で処理が中断することは無い。 ---
  const normalizedEmail = input.email.trim().toLowerCase();
  const normalizedName = input.name === "" ? null : input.name;

  const reader = await db.get<ReaderRow>(
    `insert into readers (id, tenant_id, email, name, access_token, unsubscribe_token, created_at)
     values (?, :tenant, ?, ?, ?, ?, ?)
     on conflict (tenant_id, email) do update set name = coalesce(readers.name, excluded.name)
     returning id, email, name, access_token, unsubscribe_token, unsubscribed_at`,
    [crypto.randomUUID(), normalizedEmail, normalizedName, input.accessToken, input.unsubscribeToken, input.now],
  );
  if (!reader) throw new Error("reader upsert did not return a row");

  const existingEnrollment = await db.get<{ id: string }>(
    "select id from scenario_readers where tenant_id = :tenant and reader_id = ? and scenario_id = ?",
    [reader.id, scenario.id],
  );
  const hadEnrollment = existingEnrollment !== undefined;

  const deadlineAt = addHoursIso(input.now, funnel.deadline_hours);
  const enrollment = await db.get<EnrollmentRow>(
    `insert into scenario_readers (id, tenant_id, reader_id, scenario_id, registration_path, registered_at, deadline_at)
     values (?, :tenant, ?, ?, ?, ?, ?)
     on conflict (reader_id, scenario_id) do update set reader_id = excluded.reader_id
     returning id, registered_at, deadline_at`,
    [crypto.randomUUID(), reader.id, scenario.id, input.registrationPath, input.now, deadlineAt],
  );
  if (!enrollment) throw new Error("scenario_readers upsert did not return a row");

  if (pathLabelId !== null) {
    await db.run(
      `insert into reader_labels (tenant_id, reader_id, label_id, granted_at)
       values (:tenant, ?, ?, ?)
       on conflict (reader_id, label_id) do nothing`,
      [reader.id, pathLabelId, input.now],
    );
  }

  // 「購入済みには送らない」(要件定義書 4.3-4)。1通目は claim_deliveries の送信条件
  // フィルタを通らないため、同じ判定をここで行う。対象商品が設定されていればその購入のみ、
  // 未設定ならテナント内のいずれかの購入でスキップ。
  let initialPurchaseSkip = false;
  if (initialStep && initialStep.skip_if_purchased === 1) {
    const purchase = await db.get<{ x: number }>(
      `select 1 as x from purchases
       where tenant_id = :tenant and reader_id = ? and (? is null or product_id = ?)`,
      [reader.id, funnel.product_id, funnel.product_id],
    );
    initialPurchaseSkip = purchase !== undefined;
  }

  let initialDeliveryId: string | undefined;
  // 解除済み読者にはキューを一切積まない(共通フィルタの前段)。
  if (reader.unsubscribed_at === null) {
    // D1 の1クエリあたりのバインドパラメータ上限 (D1_MAX_BIND_PARAMS=100) のため、
    // process-stripe-purchase.ts と同じ理由でチャンク化する。1ステップにつき
    // id/scenario_reader_id/step_message_id/reader_id/scheduled_at/status/error_message の
    // 7個 + tenant_idマーカー分1個 = 8個。
    const PARAMS_PER_STEP_INCLUDING_TENANT_MARKER = 8;
    const stepsPerChunk = Math.floor(D1_MAX_BIND_PARAMS / PARAMS_PER_STEP_INCLUDING_TENANT_MARKER);
    for (let offset = 0; offset < steps.length; offset += stepsPerChunk) {
      const chunk = steps.slice(offset, offset + stepsPerChunk);
      const valueTuples = chunk.map(() => "(?, :tenant, ?, ?, ?, ?, ?, ?)").join(", ");
      const params: Array<string | number | null> = [];
      for (const step of chunk) {
        const deliveryId = crypto.randomUUID();
        const isInitial = initialStep !== undefined && step.id === initialStep.id;
        if (isInitial) initialDeliveryId = deliveryId;
        const status = isInitial && initialPurchaseSkip ? "skipped" : isInitial ? "processing" : "queued";
        const errorMessage = isInitial && initialPurchaseSkip ? "delivery condition not met" : null;
        params.push(
          deliveryId,
          enrollment.id,
          step.id,
          reader.id,
          computeStepScheduledAt(enrollment.registered_at, step.delay_minutes, step.send_at_hour),
          status,
          errorMessage,
        );
      }
      await db.run(
        `insert into deliveries (id, tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at, status, error_message)
         values ${valueTuples}
         on conflict (scenario_reader_id, step_message_id) do nothing`,
        params,
      );
    }

    // 重複登録: 期限はリセットせず、1通目を queued + scheduled_at=now で積み直す。
    // 送信条件フィルタと排他制御を持つ配信ワーカーだけが送信する。送信中(processing)の
    // 行には触れない。直近の送信/予約から RESEND_COOLDOWN_MS 未満なら積み直さない(連投抑止)。
    if (hadEnrollment && initialStep) {
      const cooldownBoundary = new Date(new Date(input.now).getTime() - RESEND_COOLDOWN_MS).toISOString();
      await db.run(
        `update deliveries set status = 'queued', scheduled_at = ?, processing_started_at = null, error_message = null
         where tenant_id = :tenant and scenario_reader_id = ? and step_message_id = ?
           and status in ('sent', 'queued', 'failed', 'skipped')
           and coalesce(sent_at, scheduled_at) <= ?`,
        [input.now, enrollment.id, initialStep.id, cooldownBoundary],
      );
    }
  }

  // 即時送信の材料(subject/body/initialDeliveryId/initialGrantLabelId)は
  // 「新規登録」かつ「購入済みスキップに該当しない」場合のみ返す(Postgres 版の
  // `not had_enrollment and not initial_purchase_skip and selected_reader.unsubscribed_at is null` と同じ)。
  const shouldReturnImmediateSend =
    reader.unsubscribed_at === null && !hadEnrollment && !initialPurchaseSkip && initialStep !== undefined;

  return {
    email: reader.email,
    name: reader.name,
    accessToken: reader.access_token,
    unsubscribeToken: reader.unsubscribe_token,
    funnelSlug: funnel.slug,
    deadlineAt: enrollment.deadline_at,
    subject: shouldReturnImmediateSend ? initialStep!.subject : null,
    body: shouldReturnImmediateSend ? initialStep!.body : null,
    initialDeliveryId: shouldReturnImmediateSend ? (initialDeliveryId ?? null) : null,
    productId: funnel.product_id,
    readerId: reader.id,
    initialGrantLabelId: shouldReturnImmediateSend ? initialStep!.grant_label_id : null,
  };
}
