// issue #3: CSVインポート経路のレートリミット。
// DBカウンタ（consume_rate_limit RPC）の呼び出しと fail-open の挙動を、
// クライアントを注入して検証する。
import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeRateLimit,
  IMPORT_RATE_LIMIT_MAX_REQUESTS,
  IMPORT_RATE_LIMIT_WINDOW_SECONDS,
  importRateLimitKey,
  type RateLimitRpcClient,
} from "../../src/lib/rate-limit.ts";

function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client: RateLimitRpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { client, calls };
}

/** fail-open 時のログ出力をテスト出力に混ぜないための一時サイレンサー。 */
async function withSilencedConsoleError<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

test("importRateLimitKey はドライランと確定実行で共有される per-operator キーを作る", () => {
  assert.equal(importRateLimitKey("user-1"), "csv-import:user-1");
  assert.notEqual(importRateLimitKey("user-1"), importRateLimitKey("user-2"));
});

test("上限値は正常な操作（ドライラン→確定＋やり直し数回）を妨げない範囲にある", () => {
  assert.ok(IMPORT_RATE_LIMIT_MAX_REQUESTS >= 5, "厳しすぎると正常なやり直しまで弾く");
  assert.ok(IMPORT_RATE_LIMIT_MAX_REQUESTS <= 60, "緩すぎると資源保護にならない");
  assert.ok(IMPORT_RATE_LIMIT_WINDOW_SECONDS >= 10 && IMPORT_RATE_LIMIT_WINDOW_SECONDS <= 3600);
});

test("consumeRateLimit は RPC の判定をそのまま返し、引数を正しく渡す", async () => {
  const allowed = fakeClient({ data: true, error: null });
  assert.equal(await consumeRateLimit(allowed.client, "csv-import:u1", 10, 60), true);
  assert.deepEqual(allowed.calls, [
    { fn: "consume_rate_limit", args: { limit_key: "csv-import:u1", max_requests: 10, window_seconds: 60 } },
  ]);

  const denied = fakeClient({ data: false, error: null });
  assert.equal(await consumeRateLimit(denied.client, "csv-import:u1", 10, 60), false);
});

test("consumeRateLimit は RPC 失敗時に fail-open で true を返す（機能全体を止めない）", async () => {
  await withSilencedConsoleError(async () => {
    const failed = fakeClient({ data: null, error: { message: "function does not exist" } });
    assert.equal(await consumeRateLimit(failed.client, "csv-import:u1", 10, 60), true);

    // data が boolean でない（RPCのシグネチャが変わった等）場合も同様に fail-open。
    const malformed = fakeClient({ data: "yes", error: null });
    assert.equal(await consumeRateLimit(malformed.client, "csv-import:u1", 10, 60), true);
  });
});
