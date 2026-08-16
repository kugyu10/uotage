"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";

export function LoginForm({ supabaseUrl, anonKey, callbackUrl }: { supabaseUrl: string; anonKey: string; callbackUrl: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const configured = Boolean(supabaseUrl && anonKey);
  return <form onSubmit={async (event) => {
    event.preventDefault(); if (!configured) return; setBusy(true); setMessage("");
    const email = new FormData(event.currentTarget).get("email");
    const { error } = await createBrowserClient(supabaseUrl, anonKey).auth.signInWithOtp({
      email: String(email), options: { emailRedirectTo: callbackUrl },
    });
    setMessage(error ? "ログインメールを送信できませんでした。" : "ログイン用メールを送信しました。"); setBusy(false);
  }} className="registration-form">
    <label>メールアドレス<input name="email" type="email" required autoComplete="email" /></label>
    <button disabled={!configured || busy}>{busy ? "送信中…" : "ログイン用メールを送る"}</button>
    {!configured && <p className="form-error">Supabase Authの環境変数を設定してください。認証なしでは管理画面を利用できません。</p>}
    {message && <p>{message}</p>}
  </form>;
}
