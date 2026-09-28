/**
 * 実DBに対して consume_rate_limit を往復させる検証スクリプト（issue #3）。
 *
 * 既存テストは SQL をソース文字列の正規表現でしか見ておらず、関数を一度も実行しない。
 * register_reader は同じ検証の穴により、on conflict 推論句の変数衝突 (42702) で
 * 初版から必ず失敗していた（20260902020000 の障害記録）。consume_rate_limit も
 * 同型の on conflict を持つため、migration 適用後は必ずこのスクリプトで実挙動を確認する。
 *
 * 使い方: npm run verify:rate-limit
 *
 * 検証内容:
 *   1. 同じキーで max+1 回呼び、max 回目まで true・max+1 回目が false になること
 *   2. 別キーは影響を受けないこと
 * 副作用と安全性:
 *   - キーは verify: プレフィクス + タイムスタンプで、実オペレーターのキーと衝突しない
 *   - 作成した rate_limit_counters の行は finally で必ず削除する
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: key,
})) {
  if (!value) throw new Error(`${name} が未設定です`);
}

const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

async function rpcConsume(limitKey, maxRequests, windowSeconds) {
  const res = await fetch(`${url}/rest/v1/rpc/consume_rate_limit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ limit_key: limitKey, max_requests: maxRequests, window_seconds: windowSeconds }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`consume_rate_limit が失敗: HTTP ${res.status} ${text}`);
  }
  const value = JSON.parse(text);
  if (typeof value !== "boolean") throw new Error(`boolean 以外が返った: ${text}`);
  return value;
}

const stamp = Date.now();
const primaryKey = `verify:${stamp}`;
const otherKey = `verify:${stamp}:other`;
const MAX = 10;
const WINDOW = 60;
let failed = false;

try {
  const results = [];
  for (let i = 1; i <= MAX + 1; i += 1) {
    results.push(await rpcConsume(primaryKey, MAX, WINDOW));
  }
  const allowedCount = results.filter(Boolean).length;
  console.log(`同一キー ${MAX + 1} 回: 許可 ${allowedCount} 回 / 判定列 = ${results.join(",")}`);
  if (allowedCount !== MAX || results[MAX] !== false) {
    failed = true;
    console.error(`NG: ${MAX} 回目まで true・${MAX + 1} 回目が false になるべき`);
  }

  const other = await rpcConsume(otherKey, MAX, WINDOW);
  console.log(`別キーの1回目: ${other}`);
  if (other !== true) {
    failed = true;
    console.error("NG: 別キーが巻き添えで拒否された");
  }
} finally {
  const res = await fetch(
    `${url}/rest/v1/rate_limit_counters?limit_key=like.verify:${stamp}*`,
    { method: "DELETE", headers: { ...headers, Prefer: "count=exact" } },
  );
  console.log(`後片付け: rate_limit_counters の verify 行を削除 (HTTP ${res.status}, count=${res.headers.get("content-range")})`);
}

if (failed) {
  process.exit(1);
}
console.log("OK: consume_rate_limit は実DBで期待どおり動作");
