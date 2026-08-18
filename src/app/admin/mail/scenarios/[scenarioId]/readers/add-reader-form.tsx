"use client";

import { useActionState } from "react";

import { addReader, type AddReaderState } from "@/app/admin/mail/scenarios/[scenarioId]/readers/actions";

const initialState: AddReaderState = { status: "idle", message: "" };

export function AddReaderForm({ scenarioId }: { scenarioId: string }) {
  const [state, formAction, pending] = useActionState(addReader, initialState);

  return (
    <form action={formAction} className="admin-add-form">
      <input type="hidden" name="scenarioId" value={scenarioId} />
      <label>
        メールアドレス
        <input name="email" type="email" required maxLength={254} autoComplete="off" />
      </label>
      <label>
        名前（任意）
        <input name="name" type="text" maxLength={100} autoComplete="off" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "追加中…" : "個別追加"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="form-error">
          {state.message}
        </p>
      )}
      {state.status === "success" && <p className="form-success">{state.message}</p>}
      <p className="admin-note">
        個別追加された読者も、このシナリオのステップ配信キューに登録されます。1通目を含め即時送信は行わず、通常の配信バッチ（1分間隔の
        cron）によって送信されます。
      </p>
    </form>
  );
}
