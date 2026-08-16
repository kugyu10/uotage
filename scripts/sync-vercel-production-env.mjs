import { spawn } from "node:child_process";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const appUrl = option("app-url");
if (!appUrl?.startsWith("https://")) {
  console.error("--app-url https://<production-domain> を指定してください。");
  process.exit(64);
}
try { new URL(appUrl); } catch { console.error("--app-url は HTTPS URL 形式で指定してください。"); process.exit(64); }

const variables = [
  ["NEXT_PUBLIC_APP_URL", appUrl.replace(/\/$/, "")],
  ["NEXT_PUBLIC_OPERATOR_NAME", required("NEXT_PUBLIC_OPERATOR_NAME")],
  ["NEXT_PUBLIC_CONTACT_EMAIL", required("NEXT_PUBLIC_CONTACT_EMAIL")],
  ["NEXT_PUBLIC_OPERATOR_ADDRESS", required("NEXT_PUBLIC_OPERATOR_ADDRESS")],
  ["NEXT_PUBLIC_SUPABASE_URL", required("NEXT_PUBLIC_SUPABASE_URL")],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", required("NEXT_PUBLIC_SUPABASE_ANON_KEY")],
  ["SUPABASE_SERVICE_ROLE_KEY", required("SUPABASE_SERVICE_ROLE_KEY")],
  ["DEFAULT_TENANT_ID", required("DEFAULT_TENANT_ID")],
  ["RESEND_API_KEY", required("RESEND_API_KEY")],
  ["RESEND_FROM_EMAIL", required("RESEND_FROM_EMAIL")],
  ["RESEND_FROM_NAME", required("RESEND_FROM_NAME")],
  ["STRIPE_SECRET_KEY", required("STRIPE_SECRET_KEY")],
  ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", required("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY")],
  ["NEXT_PUBLIC_BOOKING_URL", required("NEXT_PUBLIC_BOOKING_URL")],
];

console.log("Vercel Production へ同期する変数（値は表示しません）:");
for (const [name] of variables) console.log(`  - ${name}`);
console.log("除外: RESEND_PROBE_API_KEY / STRIPE_WEBHOOK_SECRET（ローカル専用または本番Webhook専用）");

if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、同じ引数に --confirm を付けてください。");
  process.exit(66);
}

async function setVercelEnv(name, value) {
  await new Promise((resolve, reject) => {
    const child = spawn("vercel", ["env", "add", name, "production", "--force", "--yes"], {
      cwd: process.cwd(), stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Vercel環境変数 ${name} の設定に失敗しました (exit ${code})`)));
    child.stdin.end(`${value}\n`);
  });
}

for (const [name, value] of variables) await setVercelEnv(name, value);
console.log("Vercel Production 環境変数を同期しました。本番Webhook secret を設定後に vercel --prod を実行してください。");
