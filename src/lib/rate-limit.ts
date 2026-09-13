// このモジュールには2種類のレートリミットが同居している。
//   1. allowRegistration: 公開登録エンドポイント用。単一インスタンス内の bot 連打を
//      抑える補助（既存。永続的な制限は基盤側でも設定する）。
//   2. consumeRateLimit + importRateLimitKey: CSVインポート経路用（issue #3）。
//      サーバーレスでもインスタンス間で共有されるよう DB カウンタを正とする。

type Entry = { count: number; resetAt: number };
const entries = new Map<string, Entry>();

/** 単一インスタンス内のbot連打を抑える補助。永続的な制限は基盤側でも設定する。 */
export function allowRegistration(key: string, now = Date.now()): boolean {
  const current = entries.get(key);
  if (!current || current.resetAt <= now) {
    entries.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (current.count >= 5) return false;
  current.count += 1;
  return true;
}

/**
 * CSVインポート経路（ドライラン・確定実行の合算）の per-operator レートリミット（issue #3）。
 *
 * bodySizeLimit 8MB × 同時パースはメモリを圧迫するため、認証済みオペレーター1人あたり
 * 「1分間に10回」を上限にする。想定している脅威は悪意ある攻撃よりも事故
 * （スクリプトのリトライループ・二重クリック連打）で、正常な操作
 * （ドライラン→確定で2回、やり直しても数回）には十分な余裕がある値。
 */
export const IMPORT_RATE_LIMIT_MAX_REQUESTS = 10;
export const IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;

/** ドライランと確定実行で同じキーを使い、経路合算で数える。 */
export function importRateLimitKey(userId: string): string {
  return `csv-import:${userId}`;
}

/** consume_rate_limit RPC を呼べるクライアント（実体は service_role の Supabase クライアント）。 */
export interface RateLimitRpcClient {
  rpc(
    fn: "consume_rate_limit",
    args: { limit_key: string; max_requests: number; window_seconds: number },
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * レートリミットを1回消費し、実行してよいかを返す。
 *
 * カウンタは DB の固定窓（consume_rate_limit RPC、SECURITY DEFINER・service_role 限定）。
 * サーバーレス環境ではプロセス内カウンタがインスタンスごとに分かれて実効性がないため、
 * 全インスタンスで共有される DB を正とする。クライアントは呼び出し側から注入する
 * （createAdminClient は "server-only" のためテストから直接 import できない）。
 *
 * RPC の失敗（migration 未適用・DB障害）は fail-open にする: レートリミットは
 * 資源保護の補助線であり、これ自体がインポート機能を止める単一障害点になるほうが
 * 実害が大きい。ただし原因を追えるよう必ずログに残す。
 */
export async function consumeRateLimit(
  client: RateLimitRpcClient,
  limitKey: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await client.rpc("consume_rate_limit", {
    limit_key: limitKey,
    max_requests: maxRequests,
    window_seconds: windowSeconds,
  });

  if (error || typeof data !== "boolean") {
    console.error("[rate-limit] consume_rate_limit の呼び出しに失敗（fail-open で続行）", {
      limitKey,
      message:
        error instanceof Error
          ? error.message
          : ((error as { message?: string } | null)?.message ?? String(error)),
    });
    return true;
  }

  return data;
}
