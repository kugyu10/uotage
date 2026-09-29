/**
 * issue #29 [移行 P5]: Postgres 版 `import_scenario_readers`
 * (supabase/migrations/20260902010000_import_batch_row_limit.sql が最終版。
 * 初版 20260819020000 からの一連の migration の到達点) の TS 移植。
 *
 * 呼び出し方針（ADR: docs/移行P5-ADR-トランザクション設計.md 方式A）は
 * process-stripe-purchase.ts / register-reader.ts と同じ:
 *   - この関数はテナント単位の Durable Object の中から `TenantDb`（tenant-db.ts の
 *     createTenantDb が返す）越しにしか DB を触らない。
 *   - DO がテナントごとに書き込みを直列化するため、この関数自身は排他制御をしない
 *     （Postgres 版の `for share` は DO の実行モデルが肩代わりする）。
 *
 * アプリ側の分割呼び出しについて（失ってはいけない性質。ハンドオフファイルにも書く）:
 *   - src/lib/csv/import-batches.ts の `IMPORT_BATCH_SIZE`（=500）件ずつに分割して
 *     この関数を呼ぶ想定。1回の呼び出し = 1バッチ = 1回の「読む→書く」区間。
 *     バッチをまたいだ原子性はこの関数の責務外（process-stripe-purchase.ts の差分1/2と
 *     同じ理由でD1は複数文をまたぐ原子性を提供しない。再実行の安全性は下記の
 *     ON CONFLICT DO NOTHING 群が担保する）。
 *   - `input.executedAt` は「この取り込み全体（=呼び出し元が分割する全バッチ）」で
 *     同一の値を渡すこと。register_reader/process_stripe_purchase と違い、この関数は
 *     「1回の呼び出しに複数行」を処理するだけでなく「複数回の呼び出し(バッチ)」を
 *     またいで同じ意味論の基準時刻を必要とする。Postgres 版のコメント
 *     （20260902010000 マイグレーション）と同じ理由: バッチごとに違う時刻を使うと
 *     registered_at / deadline_at だけでなく「送信予定が過ぎたステップを積むか」の
 *     判定までバッチごとに動いてしまう。この関数自身は Date.now() 相当のフォールバックを
 *     持たない（register-reader.ts の `input.now` と同じ設計判断）。
 *   - 1回の呼び出しで受け付ける行数は `MAX_ROWS_PER_IMPORT_CALL`（=1000）まで。
 *     行ごとに reader / label の解決を回すため、数万行を1回で渡すとD1の実行時間制限に
 *     当たる。呼び出し側（IMPORT_BATCH_SIZE=500）は分割して呼ぶが、将来の呼び出し元が
 *     分割を忘れたときに黙って遅くなるのではなく即座に失敗させる（Postgres 版と同じ意図）。
 *
 * Postgres 版との既知の差分（判断の記録。ハンドオフファイルにも書く）:
 *   1. `step_messages` の取得を、Postgres 版のようにループの中（行ごと）ではなく
 *      ループの外（scenario/funnel 解決と同じ「読む・判断する」フェーズ）に1回だけ
 *      移動した。step_messages はこの関数の実行中に変化しないため、行ごとに同じ
 *      SELECT を繰り返しても結果は同じ。振る舞いを変えない最適化。
 *   2. process-stripe-purchase.ts / register-reader.ts と同じ理由で、複数行・複数文は
 *      まだ原子的ではない（D1は文ごとにauto-commit）。呼び出し側（バッチ分割・
 *      部分適用のUI表示）はこれを前提にした設計になっている
 *      （src/lib/csv/import-batches.ts 参照。このファイルはその前提を壊さない）。
 *   3. `readers.custom_fields` は D1 では TEXT 列（JSON文字列）。Postgres 版の
 *      `custom_fields || coalesce(row.custom_fields, '{}'::jsonb)`
 *      （jsonbの`||`は浅いマージで右辺が同名キーを上書きする）を、
 *      `JSON.parse` → スプレッド演算子による浅いマージ → `JSON.stringify` で再現する。
 *   4. Postgres 版は `for update` / `for share` で行ロックを取るが、D1 はDOの直列実行
 *      モデルが同じ役割を代替するため何もしない（process-stripe-purchase.ts と同じ判断）。
 *   5. readers の upsert は、register_reader/process_stripe_purchase が使う単一の
 *      `insert ... on conflict do update` ではなく、Postgres 版の元の構造どおり
 *      「select → 見つかれば update、無ければ insert」の分岐のままにした。
 *      import 版の update の SET 式（name は新しい値を優先、custom_fields はマージ、
 *      unsubscribed_at は「まだ未設定のときだけ立てる」）は on conflict の1文にまとめても
 *      書けなくはないが、元の構造をそのまま踏襲したほうが行ごとの分岐（"読者名は
 *      新値優先"）が register_reader（既存値優先）と逆であることを見落としにくいと判断した。
 *   6. `readers.name` の更新規則が register_reader と逆であることに注意
 *      （register_reader: 既存値があれば新値を無視。import: 新値が空でなければ新値を優先）。
 *      Postgres 版 (`name = coalesce(nullif(row_data->>'name', ''), name)`) をそのまま
 *      忠実に踏襲した結果であり、意図的な差分ではなく仕様どおり。
 *   7. `reader_labels.granted_at` / `labels.created_at` は D1 に列デフォルトが無いため
 *      （0002/0004 マイグレーション参照）明示的に値を入れる必要がある。Postgres 版は
 *      どちらも `now()` に任せているため相当する単一の値が無いが、この関数全体の
 *      「実行時刻」である `execution_time` を使う（register_reader.ts の `input.now` と
 *      同じ考え方: バッチ内で複数回 now() を呼ぶと同じ意味のはずの値がずれる）。
 *   8. `delivery_mode` の妥当性チェックはこの関数が呼び出し境界（RPC）の最終防衛線になる
 *      ため残した。TS の型 (`ImportDeliveryMode`) はコンパイル時にしか強制できず、
 *      JSON経由で外部から渡された不正な文字列を実行時に弾く必要がある
 *      （Postgres 版の SECURITY DEFINER 関数が担っていた役割と同じ）。
 *   9. `email` の正規化に `.trim()` を追加した（Postgres 版には無い）。
 *      process-stripe-purchase.ts の差分5と同じ理由: CSVの前後の空白混入に対する
 *      安全側の追加であり、Postgres 版と同じ挙動に戻す（`.trim()` を外す）だけなら
 *      欠陥ではない。
 */

import type { TenantDb } from "../d1/tenant-db.ts";
import { D1_MAX_BIND_PARAMS } from "../delivery-queue/claim.ts";
import { addHoursIso, computeStepScheduledAt } from "../purchases/process-stripe-purchase.ts";

/** Postgres 版の `jsonb_array_length(rows) > 1000` と同じ上限。 */
export const MAX_ROWS_PER_IMPORT_CALL = 1000;

export type ImportDeliveryMode = "none" | "from_now" | "from_start";

export interface ImportScenarioReaderRow {
  readonly email: string;
  /** 空文字列は Postgres 版の `nullif(row_data->>'name', '')` と同様 null 扱いにする。 */
  readonly name: string | null;
  /** 空文字列は Postgres 版の `nullif(row_data->>'registration_path', '')` と同様 null 扱いにする。 */
  readonly registrationPath: string | null;
  readonly labels: readonly string[];
  readonly customFields: Readonly<Record<string, unknown>>;
  /** 新規 reader 作成時にのみ使う。既存 reader のトークンは上書きしない。 */
  readonly accessToken: string;
  readonly unsubscribeToken: string;
  readonly unsubscribed: boolean;
}

export interface ImportScenarioReadersInput {
  readonly scenarioId: string;
  readonly deliveryMode: ImportDeliveryMode;
  /** UTC の ISO 8601 文字列。delivery_mode = 'from_now' のときだけ必須。 */
  readonly registeredAt: string | null;
  /**
   * UTC の ISO 8601 文字列。「この取り込みの実行時刻」。呼び出し側が行を複数バッチに
   * 分けてこの関数を呼ぶ場合、全バッチで同一の値を渡すこと（ヘッダコメント参照）。
   */
  readonly executedAt: string;
  /** 1回の呼び出しで処理する行。MAX_ROWS_PER_IMPORT_CALL を超えると例外。 */
  readonly rows: readonly ImportScenarioReaderRow[];
}

/** Postgres 版 `returns table (...)` と同じ5フィールド（フィールド名は camelCase）。 */
export interface ImportScenarioReadersResult {
  readonly createdReaders: number;
  readonly updatedReaders: number;
  readonly newEnrollments: number;
  readonly skippedEnrollments: number;
  readonly deliveriesQueued: number;
}

export class TooManyImportRowsError extends Error {
  constructor(count: number) {
    super(
      `too many rows in one call: ${count} (max ${MAX_ROWS_PER_IMPORT_CALL}, split the import into batches)`,
    );
    this.name = "TooManyImportRowsError";
  }
}

export class InvalidDeliveryModeError extends Error {
  constructor(mode: string) {
    super(`invalid delivery_mode: ${mode}`);
    this.name = "InvalidDeliveryModeError";
  }
}

export class RegisteredAtRequiredError extends Error {
  constructor() {
    super("target_registered_at is required for delivery_mode = from_now");
    this.name = "RegisteredAtRequiredError";
  }
}

export class ImportScenarioNotFoundError extends Error {
  constructor() {
    super("scenario not found for tenant");
    this.name = "ImportScenarioNotFoundError";
  }
}

interface ScenarioRow {
  id: string;
  funnel_id: string | null;
}

interface FunnelRow {
  id: string;
  deadline_hours: number;
}

interface StepRow {
  id: string;
  delay_minutes: number;
  send_at_hour: number | null;
}

interface ExistingReaderRow {
  id: string;
  name: string | null;
  custom_fields: string;
  unsubscribed_at: string | null;
}

interface ReaderIdentity {
  id: string;
  unsubscribed_at: string | null;
}

/** D1の1クエリあたりのバインドパラメータ上限のため、process-stripe-purchase.ts と同じ理由でチャンク化する。 */
const PARAMS_PER_STEP_INCLUDING_TENANT_MARKER = 6;
const STEPS_PER_CHUNK = Math.floor(D1_MAX_BIND_PARAMS / PARAMS_PER_STEP_INCLUDING_TENANT_MARKER);

/**
 * CSVインポートの確定実行1バッチ分を処理する。Postgres 版と同じ意味論:
 *   - scenario を tenant + id で解決する（無ければ例外）。funnel があれば期限計算に使う。
 *   - 行ごとに reader を (tenant_id, email) で upsert する。既存があれば
 *     name は「新しい値が空でなければ新値を優先」、custom_fields は浅いマージ、
 *     unsubscribed_at は「まだ未設定のときだけ、行が unsubscribed=true なら立てる」。
 *     新規なら name/custom_fields/トークン類をそのまま入れる。
 *   - CSVのラベル列: 存在しないラベルは自動作成して付与する（tenant + name で冪等）。
 *   - 再送防止オプション (delivery_mode) に応じて registered_at / deadline_at を決定する
 *     （'from_now' は呼び出し側が指定した日時、それ以外は execution_time。
 *     deadline_at は funnel.deadline_hours があれば加算、無ければ registered_at と同じ）。
 *   - scenario_readers は (reader_id, scenario_id) の UNIQUE で冪等（既に登録済みなら
 *     期限をリセットせずスキップし、deliveries も一切積まない）。
 *   - 'none' 以外かつ解除済みでない読者にのみ deliveries を積む。'from_start' は
 *     過去日のステップも含めて全ステップ積み、それ以外は execution_time より後の
 *     ステップだけ積む（過去日を指定しうる target_registered_at 基準ではなく、
 *     取り込みの実行時刻が基準 — 元のコメントと同じ理由）。
 *   - 戻り値は created_readers / updated_readers / new_enrollments / skipped_enrollments /
 *     deliveries_queued の5カウント（バッチ間の合算は呼び出し側の責務）。
 */
export async function importScenarioReaders(
  db: TenantDb,
  input: ImportScenarioReadersInput,
): Promise<ImportScenarioReadersResult> {
  if (input.rows.length > MAX_ROWS_PER_IMPORT_CALL) {
    throw new TooManyImportRowsError(input.rows.length);
  }
  if (input.deliveryMode !== "none" && input.deliveryMode !== "from_now" && input.deliveryMode !== "from_start") {
    throw new InvalidDeliveryModeError(input.deliveryMode);
  }
  if (input.deliveryMode === "from_now" && input.registeredAt === null) {
    throw new RegisteredAtRequiredError();
  }

  // --- 読む・判断するフェーズ。ここでの例外は何も書き込む前に発生する。 ---
  const scenario = await db.get<ScenarioRow>(
    "select id, funnel_id from scenarios where tenant_id = :tenant and id = ?",
    [input.scenarioId],
  );
  if (!scenario) throw new ImportScenarioNotFoundError();

  let funnel: FunnelRow | undefined;
  if (scenario.funnel_id !== null) {
    funnel = await db.get<FunnelRow>(
      "select id, deadline_hours from funnels where tenant_id = :tenant and id = ?",
      [scenario.funnel_id],
    );
  }

  // 既知の差分1: Postgres 版はこれを行ごと(ループの中)に取得するが、実行中に変化しない
  // ため一度だけ取得する。
  const steps = await db.all<StepRow>(
    "select id, delay_minutes, send_at_hour from step_messages where tenant_id = :tenant and scenario_id = ?",
    [scenario.id],
  );

  // input.now と同じ設計判断（register-reader.ts 参照）: toISOString() で必ず
  // "...Z" 形式へ正規化する。不正な形式なら早期に例外で落ちる（後続の書き込みは発生しない）。
  const executionTime = new Date(input.executedAt).toISOString();
  const registeredAtIso = input.registeredAt !== null ? new Date(input.registeredAt).toISOString() : null;

  let createdCount = 0;
  let updatedCount = 0;
  let newEnrollmentCount = 0;
  let skippedEnrollmentCount = 0;
  let queuedCount = 0;

  // --- 書くフェーズ。行ごとに「見つからないので例外」という分岐は発生しない
  //     （Postgres 版もそう。この関数は最初から「全行を無条件に処理する」設計）。 ---
  for (const row of input.rows) {
    const normalizedEmail = row.email.trim().toLowerCase();
    const normalizedName = row.name === "" ? null : row.name;
    const normalizedRegistrationPath = row.registrationPath === "" ? null : row.registrationPath;

    const existingReader = await db.get<ExistingReaderRow>(
      "select id, name, custom_fields, unsubscribed_at from readers where tenant_id = :tenant and email = ?",
      [normalizedEmail],
    );

    let reader: ReaderIdentity;
    if (existingReader) {
      const mergedCustomFields = {
        ...(JSON.parse(existingReader.custom_fields) as Record<string, unknown>),
        ...row.customFields,
      };
      const nextName = normalizedName ?? existingReader.name;
      const nextUnsubscribedAt = row.unsubscribed
        ? (existingReader.unsubscribed_at ?? executionTime)
        : existingReader.unsubscribed_at;

      const updated = await db.get<ReaderIdentity>(
        `update readers set name = ?, custom_fields = ?, unsubscribed_at = ?
         where tenant_id = :tenant and id = ?
         returning id, unsubscribed_at`,
        [nextName, JSON.stringify(mergedCustomFields), nextUnsubscribedAt, existingReader.id],
      );
      if (!updated) throw new Error("readers update did not return a row");
      reader = updated;
      updatedCount += 1;
    } else {
      const inserted = await db.get<ReaderIdentity>(
        `insert into readers (id, tenant_id, email, name, custom_fields, access_token, unsubscribe_token, unsubscribed_at, created_at)
         values (?, :tenant, ?, ?, ?, ?, ?, ?, ?)
         returning id, unsubscribed_at`,
        [
          crypto.randomUUID(),
          normalizedEmail,
          normalizedName,
          JSON.stringify(row.customFields ?? {}),
          row.accessToken,
          row.unsubscribeToken,
          row.unsubscribed ? executionTime : null,
          executionTime,
        ],
      );
      if (!inserted) throw new Error("readers insert did not return a row");
      reader = inserted;
      createdCount += 1;
    }

    // CSVのラベル列: 存在しないラベルは自動作成して付与する。
    for (const rawLabel of row.labels) {
      const trimmedLabel = rawLabel.trim();
      if (trimmedLabel.length === 0) continue;

      await db.run("insert into labels (id, tenant_id, name, created_at) values (?, :tenant, ?, ?) on conflict (tenant_id, name) do nothing", [
        crypto.randomUUID(),
        trimmedLabel,
        executionTime,
      ]);

      const label = await db.get<{ id: string }>("select id from labels where tenant_id = :tenant and name = ?", [
        trimmedLabel,
      ]);
      if (!label) throw new Error("label upsert did not resolve an id");

      await db.run(
        `insert into reader_labels (tenant_id, reader_id, label_id, granted_at)
         values (:tenant, ?, ?, ?)
         on conflict (reader_id, label_id) do nothing`,
        [reader.id, label.id, executionTime],
      );
    }

    // 再送防止オプションに応じて registered_at / deadline_at を決定する。
    const computedRegisteredAt = input.deliveryMode === "from_now" ? registeredAtIso! : executionTime;
    const computedDeadlineAt = funnel ? addHoursIso(computedRegisteredAt, funnel.deadline_hours) : computedRegisteredAt;

    // scenario_readers は冪等（既に登録済みなら期限をリセットせずスキップ）。
    const enrollment = await db.get<{ id: string; registered_at: string }>(
      `insert into scenario_readers (id, tenant_id, reader_id, scenario_id, registration_path, registered_at, deadline_at)
       values (?, :tenant, ?, ?, ?, ?, ?)
       on conflict (reader_id, scenario_id) do nothing
       returning id, registered_at`,
      [crypto.randomUUID(), reader.id, scenario.id, normalizedRegistrationPath, computedRegisteredAt, computedDeadlineAt],
    );

    if (!enrollment) {
      // 既にこのシナリオに登録済み。deliveries も一切積まずスキップする。
      skippedEnrollmentCount += 1;
      continue;
    }
    newEnrollmentCount += 1;

    // 「ステップ配信の対象にしない」以外は deliveries をキューに積む。
    // 解除済み読者には積まない（配信フィルタの前段で除外する）。
    if (input.deliveryMode !== "none" && reader.unsubscribed_at === null) {
      const scheduledSteps = steps
        .map((step) => ({
          id: step.id,
          scheduledAt: computeStepScheduledAt(enrollment.registered_at, step.delay_minutes, step.send_at_hour),
        }))
        // 'from_now' は「取り込み時点で送信予定が過ぎているステップは積まない」。
        // 基準は registered_at（過去日を指定しうる）ではなく取り込みの実行時刻。
        .filter((step) => input.deliveryMode === "from_start" || step.scheduledAt > executionTime);

      for (let offset = 0; offset < scheduledSteps.length; offset += STEPS_PER_CHUNK) {
        const chunk = scheduledSteps.slice(offset, offset + STEPS_PER_CHUNK);
        const valueTuples = chunk.map(() => "(?, :tenant, ?, ?, ?, ?)").join(", ");
        const params = chunk.flatMap((step) => [
          crypto.randomUUID(),
          enrollment.id,
          step.id,
          reader.id,
          step.scheduledAt,
        ]);
        const insertedRows = await db.all<{ inserted: number }>(
          `insert into deliveries (id, tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at)
           values ${valueTuples}
           on conflict (scenario_reader_id, step_message_id) do nothing
           returning 1 as inserted`,
          params,
        );
        queuedCount += insertedRows.length;
      }
    }
  }

  return {
    createdReaders: createdCount,
    updatedReaders: updatedCount,
    newEnrollments: newEnrollmentCount,
    skippedEnrollments: skippedEnrollmentCount,
    deliveriesQueued: queuedCount,
  };
}
