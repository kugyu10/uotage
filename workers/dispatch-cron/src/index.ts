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

function buildFunctionUrl(projectUrl: string): string {
  const normalized = projectUrl.replace(/\/+$/, "");
  return `${normalized}${FUNCTION_PATH}`;
}

async function dispatchDeliveries(env: Env): Promise<void> {
  if (!env.SUPABASE_PROJECT_URL) {
    throw new Error("SUPABASE_PROJECT_URL is not configured");
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
      // Edge Function側の一時的な失敗でWorkerごとリトライされると、次の1分後の
      // 起動と重なる可能性がある。claim_deliveries の SKIP LOCKED で致命傷には
      // ならない設計だが、ここでは例外を投げずログに残すだけに留める。
      console.error(
        `dispatch-deliveries failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      );
      return;
    }

    console.log(`dispatch-deliveries ok: ${text.slice(0, 500)}`);
  } catch (error) {
    console.error(
      `dispatch-deliveries request error: ${error instanceof Error ? error.message : String(error)}`,
    );
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
