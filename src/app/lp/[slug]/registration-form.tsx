"use client";

import { useState } from "react";

type Props = {
  funnelSlug: string;
  registrationPath: string | null;
};

export function RegistrationForm({ funnelSlug, registrationPath }: Props) {
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(formData: FormData) {
    setStatus("sending");
    setMessage("");
    const response = await fetch("/api/registrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        funnelSlug,
        registrationPath,
        email: formData.get("email"),
        name: formData.get("name"),
        website: formData.get("website"),
      }),
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setStatus("error");
      setMessage(result.error ?? "登録できませんでした。時間をおいてもう一度お試しください。");
      return;
    }
    setStatus("done");
    setMessage("メールをお送りしました。受信箱をご確認ください。");
  }

  return (
    <form action={submit} className="registration-form">
      <label>
        お名前（任意）
        <input name="name" autoComplete="name" maxLength={100} />
      </label>
      <label>
        メールアドレス
        <input name="email" type="email" autoComplete="email" required maxLength={254} />
      </label>
      <label className="honeypot" aria-hidden="true">
        ウェブサイト
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <button type="submit" disabled={status === "sending"}>
        {status === "sending" ? "送信中…" : "無料で受け取る"}
      </button>
      {message && <p className={status === "error" ? "form-error" : "form-success"}>{message}</p>}
    </form>
  );
}
