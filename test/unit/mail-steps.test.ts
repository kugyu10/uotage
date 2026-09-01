import assert from "node:assert/strict";
import test from "node:test";

import {
  renderStepTemplate,
  STEP_PLACEHOLDER_VARIABLES,
  STEP_PREVIEW_SAMPLE_VALUES,
  timingModeFromStep,
  toStepTiming,
} from "../../src/lib/mail-steps.ts";

test("即時送信は delay_minutes=0 かつ send_at_hour=null のときだけ", () => {
  assert.equal(timingModeFromStep({ delay_minutes: 0, send_at_hour: null }), "immediate");
  assert.equal(timingModeFromStep({ delay_minutes: 0, send_at_hour: 9 }), "days_after");
  assert.equal(timingModeFromStep({ delay_minutes: 1440, send_at_hour: null }), "days_after");
});

test("N日後 HH:00 を delay_minutes / send_at_hour に変換する", () => {
  assert.deepEqual(toStepTiming("immediate", 3, 9), { delayMinutes: 0, sendAtHour: null });
  assert.deepEqual(toStepTiming("days_after", 1, 0), { delayMinutes: 1440, sendAtHour: 0 });
  assert.deepEqual(toStepTiming("days_after", 3, 21), { delayMinutes: 4320, sendAtHour: 21 });
});

test("範囲外の日数・時刻は既定値（1日後 9時）に丸める", () => {
  assert.deepEqual(toStepTiming("days_after", 0, 9), { delayMinutes: 1440, sendAtHour: 9 });
  assert.deepEqual(toStepTiming("days_after", -5, 9), { delayMinutes: 1440, sendAtHour: 9 });
  assert.deepEqual(toStepTiming("days_after", Number.NaN, 9), { delayMinutes: 1440, sendAtHour: 9 });
  assert.deepEqual(toStepTiming("days_after", 1, 24), { delayMinutes: 1440, sendAtHour: 9 });
  assert.deepEqual(toStepTiming("days_after", 1, -1), { delayMinutes: 1440, sendAtHour: 9 });
  assert.deepEqual(toStepTiming("days_after", 2.7, 9.9), { delayMinutes: 2880, sendAtHour: 9 });
});

test("置き換え文字を出現箇所すべてで解決する", () => {
  assert.equal(
    renderStepTemplate("{{name}}様、{{name}}様へ", { "{{name}}": "山田" }),
    "山田様、山田様へ",
  );
});

test("未定義の置き換え文字は書き換えず残す", () => {
  assert.equal(renderStepTemplate("{{unknown}}", { "{{name}}": "山田" }), "{{unknown}}");
});

test("プレビューのサンプル値が置き換え文字6種すべてを埋める", () => {
  const rendered = renderStepTemplate(
    STEP_PLACEHOLDER_VARIABLES.map((variable) => variable.token).join("\n"),
    STEP_PREVIEW_SAMPLE_VALUES,
  );
  assert.doesNotMatch(rendered, /\{\{/, `未解決の置き換え文字が残っている: ${rendered}`);
});
