"use client";

import { useActionState, useState } from "react";

import {
  confirmImport,
  initialConfirmState,
  initialPreviewState,
  previewImport,
  type DeliveryMode,
} from "./actions";

export function ImportWizard({ scenarioId }: { scenarioId: string }) {
  const boundPreviewImport = previewImport.bind(null, scenarioId);
  const [previewState, previewAction, previewPending] = useActionState(boundPreviewImport, initialPreviewState);

  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("none");
  const boundConfirmImport = confirmImport.bind(null, scenarioId, previewState.validRows ?? []);
  const [confirmState, confirmAction, confirmPending] = useActionState(boundConfirmImport, initialConfirmState);

  if (confirmState.status === "done") {
    return (
      <div>
        <p>インポートが完了しました。</p>
        <ul>
          <li>新規作成した読者: {confirmState.createdReaders}件</li>
          <li>更新した読者: {confirmState.updatedReaders}件</li>
          <li>このシナリオへ新規登録: {confirmState.newEnrollments}件</li>
          <li>既に登録済みのためスキップ: {confirmState.skippedEnrollments}件</li>
          <li>配信キューに追加した件数: {confirmState.deliveriesQueued}件</li>
        </ul>
      </div>
    );
  }

  return (
    <div>
      <form action={previewAction}>
        <p>
          <label>
            CSVファイル（UTAGE互換、日本語ヘッダー）
            <br />
            <input type="file" name="file" accept=".csv,text/csv" required />
          </label>
        </p>
        <button type="submit" disabled={previewPending}>
          {previewPending ? "確認中…" : "ドライラン実行"}
        </button>
      </form>

      {previewState.status === "error" && <p role="alert">{previewState.error}</p>}

      {previewState.status === "ready" && (
        <div>
          <h2>ドライラン結果: {previewState.fileName}</h2>
          <ul>
            <li>取り込み対象行数: {previewState.totalRows}件</li>
            <li>新規読者: {previewState.newReaders}件</li>
            <li>既存読者（更新）: {previewState.existingReaders}件</li>
            <li>このシナリオへ既に登録済み（スキップ対象）: {previewState.alreadyEnrolled}件</li>
            <li>自動作成されるラベル: {previewState.newLabels && previewState.newLabels.length > 0 ? previewState.newLabels.join(", ") : "なし"}</li>
          </ul>

          {previewState.invalidRows && previewState.invalidRows.length > 0 && (
            <div>
              <h3>不正行（{previewState.invalidRows.length}件、取り込み対象外）</h3>
              <ul>
                {previewState.invalidRows.map((row) => (
                  <li key={row.line}>
                    {row.line}行目: {row.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form action={confirmAction}>
            <fieldset>
              <legend>再送防止オプション</legend>
              <p>
                <label>
                  <input
                    type="radio"
                    name="deliveryMode"
                    value="none"
                    checked={deliveryMode === "none"}
                    onChange={() => setDeliveryMode("none")}
                  />
                  ステップ配信の対象にしない（デフォルト・静かに移行）
                </label>
              </p>
              <p>
                <label>
                  <input
                    type="radio"
                    name="deliveryMode"
                    value="from_now"
                    checked={deliveryMode === "from_now"}
                    onChange={() => setDeliveryMode("from_now")}
                  />
                  途中から配信する
                </label>
                {deliveryMode === "from_now" && (
                  <>
                    <br />
                    <label>
                      配信を開始する日時（この時刻より後のステップのみキューに積む）
                      <br />
                      <input type="datetime-local" name="registeredAt" required />
                    </label>
                  </>
                )}
              </p>
              <p>
                <label>
                  <input
                    type="radio"
                    name="deliveryMode"
                    value="from_start"
                    checked={deliveryMode === "from_start"}
                    onChange={() => setDeliveryMode("from_start")}
                  />
                  最初から配信する（新規読者と同じ扱い）
                </label>
              </p>
            </fieldset>

            {confirmState.status === "error" && <p role="alert">{confirmState.error}</p>}

            <button type="submit" disabled={confirmPending}>
              {confirmPending ? "実行中…" : "この内容で確定して実行"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
