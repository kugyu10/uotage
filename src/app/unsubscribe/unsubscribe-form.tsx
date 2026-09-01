"use client";

import { useState } from "react";

export function UnsubscribeForm({ token, alreadyUnsubscribed }: { token: string; alreadyUnsubscribed: boolean }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (alreadyUnsubscribed) return null;
  if (done) return <p>メルマガ解除を受け付けました。以降のステップ配信は停止されます。</p>;
  return <form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch(`/api/unsubscribe?u=${encodeURIComponent(token)}`, { method: "POST" });
      if (!response.ok) throw new Error("unsubscribe failed");
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }}><button type="submit" disabled={busy}>{busy ? "処理中…" : "メルマガ解除を確定する"}</button>{error ? <p role="alert">解除処理に失敗しました。時間をおいて再度お試しください。</p> : null}</form>;
}
