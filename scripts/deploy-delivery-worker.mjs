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

// 移行 #7 以降、cron起動元は Cloudflare Workers（workers/dispatch-cron）が既定。
// pg_cron 側の (再)構成は明示的な --configure-pg-cron を指定したときだけ行う。
// うっかり付けたまま再デプロイすると pg_cron が復活し、Workers と二重起動する
// おそれがあるため、既定は「Edge Functionのデプロイとsecrets設定のみ」。
const configurePgCron = process.argv.includes("--configure-pg-cron");
if (configurePgCron) {
  console.warn(
    "[DEPRECATED] --configure-pg-cron は pg_cron 経路の再構成であり、Cloudflare Workers Cron Trigger" +
    "（workers/dispatch-cron）と同時に有効化すると二重起動になります。" +
    "Workers移行後は原則使わないでください（ロールバック時のみ想定）。",
  );
}

// レビュー指摘（#7 🔴-1）: 以前はこのスクリプトを実行するたびに CRON_SECRET を
// 無条件でローテーションしていた。Workers移行後にEdge Function単体を
// 再デプロイする目的でこのスクリプトを実行すると、Edge Function側だけ
// CRON_SECRETが変わり、Workers側（wrangler secret put CRON_SECRET）と
// 恒久的に食い違って配信が401で全停止する事故があった。
// 加えて、ローテーション後の新しい値をログに出力しない方針のため、
// 運用者が「同じ値」をWorkers側に反映する手段が無いという回復不能な
// 状態になっていた。
//
// 対策: 既定では CRON_SECRET を一切ローテーションしない
// （env-fileに含めない。`supabase secrets set --env-file` は
//  env-fileに書いたキーだけを更新するため、含めなければ既存値は
//  Supabase側にそのまま残る。CLIの挙動は公式ドキュメントの
//  差分同期パターンで確認した: env-fileに無いキーは変更されない）。
// ローテーションしたい場合は明示的に --rotate-cron-secret または
// --cron-secret <value> を指定する。その場合、運用者が値を確実に
// 受け取れるよう --cron-secret（運用者が値を選ぶ）または --secret-out
// （ランダム生成した値をファイルへ書き出す）のいずれかを必須にする。
const explicitCronSecret = option("cron-secret");
if (explicitCronSecret !== undefined && /\r|\n/.test(explicitCronSecret)) {
  console.error("--cron-secret に改行を含めることはできません。");
  process.exit(64);
}
const rotateCronSecretFlag = process.argv.includes("--rotate-cron-secret");
const rotateCronSecret = rotateCronSecretFlag || explicitCronSecret !== undefined;
const secretOutPath = option("secret-out");

if (configurePgCron && !rotateCronSecret) {
  console.error(
    "--configure-pg-cron を使う場合は pg_cron の Vault に書き込む値が必要です。" +
    "--cron-secret <value> か --rotate-cron-secret も指定してください。",
  );
  process.exit(64);
}
if (rotateCronSecretFlag && explicitCronSecret === undefined && !secretOutPath) {
  console.error(
    "--rotate-cron-secret でランダム生成した値を運用者が取得する手段がありません。" +
    "--cron-secret <value> で値を指定するか、--secret-out <path> で書き出し先を指定してください。",
  );
  process.exit(64);
}

console.log(JSON.stringify({
  action: "deploy-delivery-worker",
  projectRef,
  function: "dispatch-deliveries",
  appUrl: appUrl.replace(/\/$/, ""),
  configurePgCron,
  configureCron: configurePgCron ? "dispatch-deliveries-every-minute (* * * * *)" : "スキップ（Cloudflare Workers Cron Triggerを使用）",
  cronSecretRotation: !rotateCronSecret ? "unchanged" : (explicitCronSecret !== undefined ? "explicit" : "random"),
  invokeAfterDeploy: sendNow || probe,
  targetedDeliveryId: deliveryId ?? null,
  secretHandling: "一時ファイルにのみ作成し、終了時に削除。値は表示しません。",
}, null, 2));

if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、--confirm を付けてください。--probe は期限到来済みの配信を処理し、--send-now と --delivery-id は指定したキュー済みメールだけを処理します。");
  process.exit(66);
}

const cronSecret = rotateCronSecret ? (explicitCronSecret ?? randomBytes(32).toString("base64url")) : undefined;
const secretDir = await mkdtemp(join(tmpdir(), "uotage-dispatch-"));
const secretFile = join(secretDir, "edge-secrets.env");
try {
  await writeFile(secretFile, [
    `APP_URL=${appUrl.replace(/\/$/, "")}`,
    ...(cronSecret !== undefined ? [`CRON_SECRET=${cronSecret}`] : []),
    `RESEND_API_KEY=${required("RESEND_API_KEY")}`,
    "",
  ].join("\n"), { mode: 0o600 });

  await run("supabase", ["functions", "deploy", "dispatch-deliveries", "--no-verify-jwt", "--project-ref", projectRef]);
  await run("supabase", ["secrets", "set", "--project-ref", projectRef, "--env-file", secretFile]);

  if (cronSecret !== undefined && secretOutPath) {
    await writeFile(secretOutPath, `${cronSecret}\n`, { mode: 0o600 });
    console.log(
      `新しいCRON_SECRETを ${secretOutPath} に書き出しました（権限0600）。` +
      "この値を `wrangler secret put CRON_SECRET`（workers/dispatch-cron）に入力したら、" +
      "このファイルは運用者自身で削除してください。",
    );
  }

  if (configurePgCron) {
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
  } else if (cronSecret !== undefined) {
    console.log(
      "pg_cronの構成はスキップしました。CRON_SECRETをローテーションしたため、" +
      "Cloudflare Workers側のシークレット（workers/dispatch-cron, wrangler secret put CRON_SECRET）も" +
      "同じ値に更新してください。" +
      (secretOutPath ? `値は ${secretOutPath} に書き出し済みです。` : "値は --cron-secret に指定したものと同じです。"),
    );
  } else {
    console.log("CRON_SECRETは変更していません。Workers側（wrangler secret put CRON_SECRET）の設定はそのままで構いません。");
  }

  if (!sendNow && !probe) {
    console.log("配信ワーカーをデプロイして環境変数を設定しました。直接起動は行っていません。");
  } else {
    if (cronSecret === undefined) {
      throw new Error("--send-now/--probe で直接起動するには、CRON_SECRETの値が必要です。--cron-secret か --rotate-cron-secret を指定してください。");
    }
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
