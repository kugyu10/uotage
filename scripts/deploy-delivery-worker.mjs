import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  if (/\r|\n/.test(value)) throw new Error(`${name} に改行を含めることはできません`);
  return value;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} の実行に失敗しました (exit ${code})`)));
  });
}

const appUrl = option("app-url");
if (!appUrl?.startsWith("https://")) {
  console.error("--app-url https://<production-domain> を指定してください。");
  process.exit(64);
}
try { new URL(appUrl); } catch { console.error("--app-url は HTTPS URL 形式で指定してください。"); process.exit(64); }

const projectRef = required("SUPABASE_PROJECT_REF");
const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const functionUrl = `${supabaseUrl}/functions/v1/dispatch-deliveries`;
const sendNow = process.argv.includes("--send-now");
const probe = process.argv.includes("--probe");
const deliveryId = option("delivery-id");
if (sendNow && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId ?? "")) {
  console.error("--send-now には --delivery-id <queued delivery UUID> が必要です。");
  process.exit(64);
}

console.log(JSON.stringify({
  action: "deploy-delivery-worker",
  projectRef,
  function: "dispatch-deliveries",
  appUrl: appUrl.replace(/\/$/, ""),
  configureCron: "dispatch-deliveries-every-minute (* * * * *)",
  invokeAfterDeploy: sendNow || probe,
  targetedDeliveryId: deliveryId ?? null,
  secretHandling: "一時ファイルにのみ作成し、終了時に削除。値は表示しません。",
}, null, 2));

if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、--confirm を付けてください。--probe は期限到来済みの配信を処理し、--send-now と --delivery-id は指定したキュー済みメールだけを処理します。");
  process.exit(66);
}

const cronSecret = randomBytes(32).toString("base64url");
const secretDir = await mkdtemp(join(tmpdir(), "uotage-dispatch-"));
const secretFile = join(secretDir, "edge-secrets.env");
try {
  await writeFile(secretFile, [
    `APP_URL=${appUrl.replace(/\/$/, "")}`,
    `CRON_SECRET=${cronSecret}`,
    `RESEND_API_KEY=${required("RESEND_API_KEY")}`,
    "",
  ].join("\n"), { mode: 0o600 });

  await run("supabase", ["functions", "deploy", "dispatch-deliveries", "--no-verify-jwt", "--project-ref", projectRef]);
  await run("supabase", ["secrets", "set", "--project-ref", projectRef, "--env-file", secretFile]);

  const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
  const cronResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/configure_delivery_cron`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_project_url: supabaseUrl, p_cron_secret: cronSecret }),
  });
  if (!cronResponse.ok) {
    throw new Error(`配信cronの構成に失敗しました (HTTP ${cronResponse.status})。migrationが反映済みか確認してください。`);
  }
  const cronJobId = await cronResponse.json();
  if (!Number.isInteger(cronJobId)) throw new Error("配信cronの構成結果が不正です");
  console.log(`配信cronを1分間隔で構成しました: job ${cronJobId}`);

  if (!sendNow && !probe) {
    console.log("配信ワーカーをデプロイして環境変数を設定しました。直接起動は行っていません。");
  } else {
    const response = await fetch(functionUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cronSecret}`,
        "content-type": "application/json",
        ...(deliveryId ? { "x-uotage-delivery-id": deliveryId } : {}),
      },
      body: "{}",
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`配信ワーカーの起動に失敗しました (HTTP ${response.status}): ${body.slice(0, 300)}`);
    console.log(`配信ワーカーを一度起動しました: ${body}`);
  }
} finally {
  await rm(secretDir, { recursive: true, force: true });
}
