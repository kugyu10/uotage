// #9 レビュー[最高]-1: requireOperator() 全体（S4/S5 の壊し方）を守るテスト。
// 本体は src/lib/operator-session.ts の resolveOperator()（"server-only" /
// next/headers 非依存の純関数）を直接呼び、DB 問い合わせ部分だけスタブに差し替える。
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAccessEmail, resolveOperator } from "../../src/lib/operator-session.ts";
import type { Operator } from "../../src/lib/operator-session.ts";

test("ヘッダーが無ければ missing-email になり、DB へは問い合わせない（S5を殺す）", async () => {
  let called = false;
  const result = await resolveOperator(null, async () => {
    called = true;
    return null;
  });
  assert.equal(result.status, "missing-email");
  assert.equal(called, false);
});

test("未登録メールなら not-found になる", async () => {
  const result = await resolveOperator("nobody@example.com", async () => null);
  assert.equal(result.status, "not-found");
});

test("登録済みメールなら found になり、operator を返す", async () => {
  const operator: Operator = { tenant_id: "tenant-1", user_id: "reader@example.com" };
  const result = await resolveOperator("reader@example.com", async () => operator);
  assert.equal(result.status, "found");
  assert.deepEqual(result.status === "found" ? result.operator : null, operator);
});

// [最高]-1 S4 系: resolveOperator() 自体は渡されたメールをそのまま findOperator へ
// 渡すだけで絞り込みはしない（絞り込みは呼び出し側 = server.ts の
// `.eq("user_id", normalizedEmail)` が担う）。resolveOperator が受け取った引数を
// 改変せず正しく findOperator へ渡していることをここで確認し、server.ts 側が
// その値を実際に .eq() のフィルタとして使っていることは
// test/admin-auth.test.mjs のソース走査（`.eq\("user_id", normalizedEmail\)`）で
// 別途保証する（server.ts は "server-only" 依存のためここで直接実行できない）。
test("findOperator には正規化済み（小文字化・トリム）のメールアドレスが渡される", async () => {
  const received: string[] = [];
  await resolveOperator(" Reader@Example.com ", async (normalizedEmail) => {
    received.push(normalizedEmail);
    return null;
  });
  assert.deepEqual(received, ["reader@example.com"]);
});

test("normalizeAccessEmail は前後空白を除去し小文字化する", () => {
  assert.equal(normalizeAccessEmail(" Reader@Example.COM "), "reader@example.com");
});
