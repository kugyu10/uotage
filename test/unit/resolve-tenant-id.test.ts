// issue #29 [移行 P5] レビュー 🟡-7: workers/tenant-do/src/index.ts の tenantId() から
// 切り出した src/lib/d1/resolve-tenant-id.ts のテスト。
import assert from "node:assert/strict";
import test from "node:test";

import { resolveTenantIdFromDoName } from "../../src/lib/d1/resolve-tenant-id.ts";

test("resolveTenantIdFromDoName: name があればそのまま返す", () => {
  assert.equal(resolveTenantIdFromDoName("tenant-a"), "tenant-a");
});

test("resolveTenantIdFromDoName: null は例外", () => {
  assert.throws(() => resolveTenantIdFromDoName(null), /idFromName\(tenantId\)/);
});

test("resolveTenantIdFromDoName: undefined は例外", () => {
  assert.throws(() => resolveTenantIdFromDoName(undefined), /idFromName\(tenantId\)/);
});

test("resolveTenantIdFromDoName: 空文字列は例外", () => {
  assert.throws(() => resolveTenantIdFromDoName(""), /idFromName\(tenantId\)/);
});
