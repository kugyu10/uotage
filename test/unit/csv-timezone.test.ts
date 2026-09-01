import assert from "node:assert/strict";
import test from "node:test";

import { formatJstDateTime, jstDatetimeLocalToUtcIso } from "../../src/lib/csv/timezone.ts";

test("UTC の ISO 文字列を Asia/Tokyo 表記へ変換する", () => {
  assert.equal(formatJstDateTime("2026-08-19T00:00:00.000Z"), "2026-08-19 09:00:00");
  // JST が日付を越えるケース。
  assert.equal(formatJstDateTime("2026-08-19T15:30:45.000Z"), "2026-08-20 00:30:45");
});

test("JST 深夜0時を 24:00 ではなく 00:00 と表記する", () => {
  assert.match(formatJstDateTime("2026-08-18T15:00:00.000Z"), /^2026-08-19 00:00:00$/);
});

test("datetime-local の値を JST の壁時計時刻として UTC へ変換する", () => {
  assert.equal(jstDatetimeLocalToUtcIso("2026-08-19T09:00"), "2026-08-19T00:00:00.000Z");
  assert.equal(jstDatetimeLocalToUtcIso("2026-08-19T00:30:45"), "2026-08-18T15:30:45.000Z");
});

test("往復させても JST の壁時計時刻が保たれる", () => {
  const local = "2026-08-19T14:05:00";
  assert.equal(formatJstDateTime(jstDatetimeLocalToUtcIso(local)), "2026-08-19 14:05:00");
});

test("Asia/Tokyo は夏時間を持たないため、季節で差が出ない", () => {
  assert.equal(jstDatetimeLocalToUtcIso("2026-01-15T12:00"), "2026-01-15T03:00:00.000Z");
  assert.equal(jstDatetimeLocalToUtcIso("2026-07-15T12:00"), "2026-07-15T03:00:00.000Z");
});

test("形式が不正な値は INVALID_DATETIME を投げる", () => {
  for (const value of ["", "2026-08-19", "2026/08/19T09:00", "2026-08-19 09:00"]) {
    assert.throws(() => jstDatetimeLocalToUtcIso(value), /INVALID_DATETIME/, `value=${value}`);
  }
});
