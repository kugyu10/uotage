/**
 * Cloudflare Workers Cron Trigger（1分間隔）から Supabase Edge Function
 * `dispatch-deliveries` を叩くだけの薄いWorker。
 *
 * DBにもアプリコードにも触らない。既存のpg_cron構成（
 * supabase/migrations/20260817010000_configure_delivery_cron.sql）が
 * 生成していたリクエストと同じ形（POST + Authorization: Bearer <CRON_SECRET>）
 * を踏襲する。認証方式そのものは変更しない。
 *
 * 必要なシークレットはWorkers Secretsに保存すること。値をこのファイルや
 * リポジトリのどこにも書かない。
 *   - SUPABASE_PROJECT_URL: 例 https://xxxxxxxx.supabase.co
 *   - CRON_SECRET: dispatch-deliveries Edge Function が検証する共有シークレット
 *     （pg_cron停止までは、Vaultに保存されている既存値と同じものを使うこと。
 *     二重管理を避けたい場合は切替時にローテーションしてよいが、その場合は
 *     Edge Function側のCRON_SECRETも同時に更新する必要がある）
 *
 * 設定手順は README.md を参照。
 */

export interface Env {
  SUPABASE_PROJECT_URL: string;
  CRON_SECRET: string;
}

const FUNCTION_PATH = "/functions/v1/dispatch-deliveries";
const REQUEST_TIMEOUT_MS = 15_000;
// 置き換え元の configure_delivery_cron（supabase/migrations/20260817010000_...sql）が
// p_project_url に課していたのと同じ形式チェック。誤って http:// や末尾パス付き、
// 別ホストを設定してしまうと CRON_SECRET を意図しない宛先へ Bearer で送ることに
// なるため、Workers Secrets側でも同じ強さで弾く（#7 レビュー指摘 🟢-1）。
const SUPABASE_PROJECT_URL_PATTERN = /^https:\/\/[a-z0-9]+\.supabase\.co$/;

function buildFunctionUrl(projectUrl: string): string {
  const normalized = projectUrl.replace(/\/+$/, "");
  return `${normalized}${FUNCTION_PATH}`;
}

async function dispatchDeliveries(env: Env): Promise<void> {
  if (!env.SUPABASE_PROJECT_URL) {
    throw new Error("SUPABASE_PROJECT_URL is not configured");
  }
  const normalizedProjectUrl = env.SUPABASE_PROJECT_URL.replace(/\/+$/, "");
  if (!SUPABASE_PROJECT_URL_PATTERN.test(normalizedProjectUrl)) {
    throw new Error(
      `SUPABASE_PROJECT_URL is not a valid https://<ref>.supabase.co URL: ${normalizedProjectUrl}`,
    );
  }
  if (!env.CRON_SECRET) {
    throw new Error("CRON_SECRET is not configured");
  }

  const url = buildFunctionUrl(env.SUPABASE_PROJECT_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.CRON_SECRET}`,
      },
      body: "{}",
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const message = `dispatch-deliveries failed: HTTP ${response.status} ${text.slice(0, 500)}`;
      console.error(message);
      // レビュー指摘（#7 🟡-1）で握りつぶしを見直した。Cloudflareの scheduled
      // ハンドラは失敗しても自動リトライしない（公式ドキュメントで確認済み:
      // https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
      // 「失敗したinvocationはリトライされず、次のcron時刻まで待つだけ」）。
      // つまり「リトライで次分の起動と重なる」という当初のコメントの懸念には
      // 根拠が無かった。一方でここでreturnして握りつぶすと、Cron Triggersの
      // Past Eventsが常に成功扱いになり、Edge Functionが401等を返し続けて
      // 配信が全停止していても誰も気づけなくなる。throwしてinvocationを
      // 失敗として記録させる。
      throw new Error(message);
    }

    console.log(`dispatch-deliveries ok: ${text.slice(0, 500)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("dispatch-deliveries failed:")) {
      // 直前でログ済み・throw済みのエラーはそのまま再送出する。
      throw error;
    }
    const message = `dispatch-deliveries request error: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    // 上と同じ理由でthrowし、Cron TriggerのPast Eventsに失敗として残す。
    throw error instanceof Error ? error : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(dispatchDeliveries(env));
  },

  // scheduledハンドラのみを提供するWorker。HTTPリクエストは受け付けない。
  async fetch(): Promise<Response> {
    return new Response("uotage-dispatch-cron: scheduled worker only", {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
