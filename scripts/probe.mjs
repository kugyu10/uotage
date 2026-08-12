#!/usr/bin/env node
/**
 * 疎通・認証の確認スクリプト。
 *
 *   npm run probe
 *
 * Supabase / Resend / Stripe に実際にリクエストを投げ、
 * 「キーが有効か」「送信ドメインが認証済みか」までを判定する。
 *
 * 夜間の自律実行に入る前にこれが全て緑になっていることが前提。
 * 赤のまま走らせても、認証待ちで止まるだけで朝には何も進んでいない。
 *
 * 終了コード: 0 = 全て必須項目が通過 / 1 = 必須項目に失敗あり
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// .env.local の読み込み（依存を増やしたくないので自前で最小限のパース）
// ---------------------------------------------------------------------------
function loadEnvFile(name) {
  const path = resolve(ROOT, name);
  if (!existsSync(path)) return false;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const loaded = [".env.local", ".env"].filter(loadEnvFile);

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `[${code}m${s}[0m` : s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const yellow = (s) => paint("33", s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);

const results = [];

/** 1件の検査を実行して結果を記録する。 */
async function check({ name, required = true, run }) {
  if (tty) process.stdout.write(dim(`  … ${name}`) + "\r");
  let outcome;
  try {
    outcome = (await run()) ?? { ok: true };
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const status = outcome.ok ? green("PASS") : required ? red("FAIL") : yellow("WARN");
  process.stdout.write(`  ${status}  ${name}`.padEnd(tty ? 60 : 0) + "\n");
  if (outcome.detail) {
    for (const line of String(outcome.detail).split("\n")) {
      console.log(dim(`        ${line}`));
    }
  }
  results.push({ name, required, ok: outcome.ok });
  return outcome;
}

/** 環境変数が存在すれば返し、無ければ検査を失敗させる。 */
function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が未設定です（.env.local を確認）`);
  return value;
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// 検査本体
// ---------------------------------------------------------------------------
console.log(bold("\n疎通・認証チェック\n"));
console.log(
  dim(
    loaded.length
      ? `  読み込んだファイル: ${loaded.join(", ")}\n`
      : "  .env.local が見つかりません。cp .env.example .env.local から始めてください。\n",
  ),
);

// --- Supabase --------------------------------------------------------------
console.log(bold("Supabase"));

await check({
  name: "REST API に service role キーで到達できる",
  run: async () => {
    const url = need("NEXT_PUBLIC_SUPABASE_URL");
    const key = need("SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `キーが拒否されました (HTTP ${response.status})` };
    }
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    return { ok: true, detail: `HTTP ${response.status} / ${url}` };
  },
});

await check({
  name: "Auth Admin API に到達できる（管理画面ログインの土台）",
  run: async () => {
    const url = need("NEXT_PUBLIC_SUPABASE_URL");
    const key = need("SUPABASE_SERVICE_ROLE_KEY");
    const response = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const body = await json(response);
    const count = Array.isArray(body.users) ? body.users.length : 0;
    return {
      ok: true,
      detail:
        count === 0
          ? "ユーザー0件。管理画面にログインするには手動でユーザー作成が必要（新規サインアップは無効化する方針）"
          : `既存ユーザーあり`,
    };
  },
});

await check({
  name: "anon キーが有効",
  required: false,
  run: async () => {
    const url = need("NEXT_PUBLIC_SUPABASE_URL");
    const key = need("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    const response = await fetch(`${url}/rest/v1/`, { headers: { apikey: key } });
    return response.ok
      ? { ok: true }
      : { ok: false, detail: `HTTP ${response.status}` };
  },
});

// --- Resend ----------------------------------------------------------------
console.log(bold("\nResend"));

await check({
  name: "API キーが有効",
  run: async () => {
    const key = need("RESEND_API_KEY");
    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.status === 401) return { ok: false, detail: "APIキーが無効です" };
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    return { ok: true };
  },
});

await check({
  name: "差出人ドメインが認証済み（SPF/DKIM/DMARC）",
  run: async () => {
    const key = need("RESEND_API_KEY");
    const from = need("RESEND_FROM_EMAIL");
    const fromDomain = from.split("@")[1]?.toLowerCase();
    if (!fromDomain) {
      return { ok: false, detail: `RESEND_FROM_EMAIL の形式が不正です: ${from}` };
    }

    const response = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return { ok: false, detail: `ドメイン一覧の取得に失敗 (HTTP ${response.status})` };

    const body = await json(response);
    const domains = body.data ?? [];
    if (domains.length === 0) {
      return {
        ok: false,
        detail:
          "Resend にドメインが1件も登録されていません。\n" +
          "https://resend.com/domains でドメインを追加し、表示された DNS レコードを登録してください。",
      };
    }

    const match = domains.find((d) => String(d.name).toLowerCase() === fromDomain);
    if (!match) {
      return {
        ok: false,
        detail:
          `${fromDomain} が Resend に登録されていません。\n` +
          `登録済み: ${domains.map((d) => `${d.name} (${d.status})`).join(", ")}`,
      };
    }
    if (match.status !== "verified") {
      return {
        ok: false,
        detail:
          `${fromDomain} の状態は "${match.status}" です（verified が必要）。\n` +
          "DNS レコードの登録漏れ、または伝播待ちです。伝播には数分〜数時間かかります。",
      };
    }
    return { ok: true, detail: `${fromDomain} は verified` };
  },
});

// --- Stripe ----------------------------------------------------------------
console.log(bold("\nStripe"));

await check({
  name: "シークレットキーが有効",
  run: async () => {
    const key = need("STRIPE_SECRET_KEY");
    const response = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
      const body = await json(response);
      return { ok: false, detail: body.error?.message ?? `HTTP ${response.status}` };
    }
    const mode = key.startsWith("sk_live_") ? "本番キー" : "テストキー";
    return {
      ok: true,
      detail: mode === "本番キー" ? yellow("本番キーです。MVP 中はテストキー推奨") : mode,
    };
  },
});

await check({
  name: "Webhook 署名シークレットが設定されている",
  run: async () => {
    const secret = need("STRIPE_WEBHOOK_SECRET");
    if (!secret.startsWith("whsec_")) {
      return { ok: false, detail: `whsec_ で始まる値が必要です（現在: ${secret.slice(0, 8)}…）` };
    }
    return { ok: true, detail: "値の形式のみ確認。実際の検証は Webhook 受信時" };
  },
});

// --- アプリ設定 -------------------------------------------------------------
console.log(bold("\nアプリ設定"));

await check({
  name: "NEXT_PUBLIC_APP_URL が設定されている",
  run: () => {
    const url = need("NEXT_PUBLIC_APP_URL");
    new URL(url);
    return { ok: true, detail: url };
  },
});

await check({
  name: "個別相談の予約URL が設定されている",
  required: false,
  run: () => {
    const url = need("NEXT_PUBLIC_BOOKING_URL");
    new URL(url);
    return { ok: true, detail: url };
  },
});

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.required && !r.ok);
const warned = results.filter((r) => !r.required && !r.ok);

console.log("");
if (failed.length === 0) {
  console.log(green(bold("すべての必須項目が通過しました。")));
  if (warned.length > 0) {
    console.log(yellow(`任意項目の未達 ${warned.length} 件: ${warned.map((r) => r.name).join(" / ")}`));
  }
  console.log("");
  process.exit(0);
}

console.log(red(bold(`必須項目の失敗 ${failed.length} 件:`)));
for (const r of failed) console.log(red(`  - ${r.name}`));
console.log("");
process.exit(1);
