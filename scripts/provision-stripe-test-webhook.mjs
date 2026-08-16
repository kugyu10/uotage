import { spawn } from "node:child_process";
import Stripe from "stripe";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です`);
  return value;
}

const baseUrl = option("url", "https://uotage.vercel.app").replace(/\/$/, "");
if (!baseUrl.startsWith("https://")) {
  console.error("--url https://<production-domain> を指定してください。");
  process.exit(64);
}
try { new URL(baseUrl); } catch { console.error("--url は HTTPS URL 形式で指定してください。"); process.exit(64); }

const webhookUrl = `${baseUrl}/api/stripe/webhook`;
const stripeKey = required("STRIPE_SECRET_KEY");
if (!stripeKey.startsWith("sk_test_")) {
  console.error("このコマンドは Stripe テストモード (sk_test_) 専用です。本番決済は別途ライブキーで明示的に設定してください。");
  process.exit(65);
}

console.log(JSON.stringify({
  action: "provision-stripe-test-webhook",
  webhookUrl,
  events: ["checkout.session.completed"],
  targetEnvironment: "Vercel Production",
}, null, 2));
if (process.argv.includes("--dry-run")) process.exit(0);
if (!process.argv.includes("--confirm")) {
  console.error("内容を確認後、同じ引数に --confirm を付けてください。Stripe テストWebhookを作成し、署名シークレットをVercelへ設定します。");
  process.exit(66);
}

function setVercelWebhookSecret(value) {
  return new Promise((resolve, reject) => {
    const child = spawn("vercel", ["env", "add", "STRIPE_WEBHOOK_SECRET", "production", "--force", "--yes"], {
      cwd: process.cwd(), stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Vercel環境変数の設定に失敗しました (exit ${code})`)));
    child.stdin.end(`${value}\n`);
  });
}

const stripe = new Stripe(stripeKey);
const existing = await stripe.webhookEndpoints.list({ limit: 100 });
if (existing.data.some((endpoint) => endpoint.url === webhookUrl)) {
  console.error(`同じURLのStripe Webhookが既にあります。secret は作成時しか取得できないため、Stripe Dashboardで新しいendpointを作るか既存endpointを削除してから実行してください: ${webhookUrl}`);
  process.exit(67);
}

let endpoint;
try {
  endpoint = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: ["checkout.session.completed"],
    description: "UOTAGE production deployment (test mode)",
  });
  if (!endpoint.secret) throw new Error("Stripe がWebhook署名シークレットを返しませんでした");
  await setVercelWebhookSecret(endpoint.secret);
  console.log(`Stripe Webhookを作成し、Vercelへ署名シークレットを設定しました: ${endpoint.id}`);
  console.log("次に vercel --prod を実行して環境変数を反映してください。");
} catch (error) {
  if (endpoint) await stripe.webhookEndpoints.del(endpoint.id).catch(() => {});
  throw error;
}
