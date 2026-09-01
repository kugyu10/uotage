"use client";

import { useRef, useState } from "react";

import {
  renderStepTemplate,
  STEP_PLACEHOLDER_VARIABLES,
  STEP_PREVIEW_SAMPLE_VALUES,
  type StepTimingMode,
} from "@/lib/mail-steps";

type Label = { id: string; name: string };

type Props = {
  initial: {
    subject: string;
    body: string;
    timingMode: StepTimingMode;
    daysAfter: number;
    sendHour: number;
    skipIfPurchased: boolean;
    grantLabelId: string;
  };
  labels: Label[];
  updateStepAction: (formData: FormData) => void | Promise<void>;
  sendTestStepAction: (subject: string, body: string) => Promise<{ id: string }>;
};

export function StepEditor({ initial, labels, updateStepAction, sendTestStepAction }: Props) {
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [timingMode, setTimingMode] = useState<StepTimingMode>(initial.timingMode);
  const [daysAfter, setDaysAfter] = useState(initial.daysAfter);
  const [sendHour, setSendHour] = useState(initial.sendHour);
  const [skipIfPurchased, setSkipIfPurchased] = useState(initial.skipIfPurchased);
  const [grantLabelId, setGrantLabelId] = useState(initial.grantLabelId);
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insertPlaceholder(token: string) {
    const textarea = bodyRef.current;
    if (!textarea) {
      setBody((current) => current + token);
      return;
    }
    const start = textarea.selectionStart ?? body.length;
    const end = textarea.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    const cursor = start + token.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  async function handleTestSend() {
    setTestStatus("sending");
    setTestMessage("");
    try {
      await sendTestStepAction(subject, body);
      setTestStatus("sent");
      setTestMessage("テスト送信を受け付けました。");
    } catch {
      setTestStatus("error");
      setTestMessage("テスト送信に失敗しました。");
    }
  }

  const previewSubject = renderStepTemplate(subject, STEP_PREVIEW_SAMPLE_VALUES);
  const previewBody = renderStepTemplate(body, STEP_PREVIEW_SAMPLE_VALUES);

  return (
    <>
      <form action={updateStepAction} className="admin-form">
        <fieldset className="admin-fieldset">
          <legend>送信タイミング</legend>
          <label className="admin-radio">
            <input
              type="radio"
              name="timing_mode"
              value="immediate"
              checked={timingMode === "immediate"}
              onChange={() => setTimingMode("immediate")}
            />
            シナリオ登録直後
          </label>
          <label className="admin-radio">
            <input
              type="radio"
              name="timing_mode"
              value="days_after"
              checked={timingMode === "days_after"}
              onChange={() => setTimingMode("days_after")}
            />
            <input
              type="number"
              name="days_after"
              min={1}
              value={daysAfter}
              disabled={timingMode !== "days_after"}
              onChange={(event) => setDaysAfter(Number(event.target.value))}
              className="admin-inline-number"
            />
            日後
            <input
              type="number"
              name="send_hour"
              min={0}
              max={23}
              value={sendHour}
              disabled={timingMode !== "days_after"}
              onChange={(event) => setSendHour(Number(event.target.value))}
              className="admin-inline-number"
            />
            :00
          </label>
        </fieldset>

        <label>
          件名
          <input name="subject" type="text" required value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>

        <div className="admin-step-body-row">
          <label className="admin-step-body-field">
            本文
            <textarea
              ref={bodyRef}
              name="body"
              rows={14}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <div className="admin-placeholder-panel">
            <p>置き換え文字（クリックで挿入）</p>
            <div className="admin-placeholder-buttons">
              {STEP_PLACEHOLDER_VARIABLES.map((variable) => (
                <button type="button" key={variable.token} onClick={() => insertPlaceholder(variable.token)}>
                  {variable.label}
                  <code>{variable.token}</code>
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="admin-checkbox">
          <input
            type="checkbox"
            name="skip_if_purchased"
            checked={skipIfPurchased}
            onChange={(event) => setSkipIfPurchased(event.target.checked)}
          />
          購入済みには送らない
        </label>

        <label>
          送信後に付与するラベル（アクション）
          <select name="grant_label_id" value={grantLabelId} onChange={(event) => setGrantLabelId(event.target.value)}>
            <option value="">なし</option>
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
        </label>

        <button type="submit">保存する</button>
      </form>

      <section className="admin-panel">
        <h2>プレビュー</h2>
        <p>
          <strong>件名: </strong>
          {previewSubject || "(件名未設定)"}
        </p>
        <pre className="admin-preview-body">{previewBody}</pre>
      </section>

      <section className="admin-panel">
        <h2>自分宛のテスト送信</h2>
        <p className="admin-meta">件名に「[テスト] 」を付けて、ログイン中のメールアドレスへ1件だけ送信します。</p>
        <button type="button" className="button-secondary" disabled={testStatus === "sending"} onClick={handleTestSend}>
          {testStatus === "sending" ? "送信中…" : "テスト送信する"}
        </button>
        {testMessage && <p>{testMessage}</p>}
      </section>
    </>
  );
}
