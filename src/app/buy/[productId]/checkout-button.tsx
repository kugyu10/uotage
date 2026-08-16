"use client";

import { useState } from "react";

export function CheckoutButton({ productId }: { productId: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function beginCheckout() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const result = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !result.url) {
        setMessage(result.error ?? "決済画面を開けませんでした。時間をおいて再度お試しください。");
        return;
      }
      window.location.assign(result.url);
    } catch {
      setMessage("通信に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="checkout-button" type="button" disabled={busy} onClick={beginCheckout}>
      {busy ? "決済画面を開いています…" : "安全に購入手続きへ進む"}
    </button>
    {message && <p className="form-error">{message}</p>}
  </>;
}
