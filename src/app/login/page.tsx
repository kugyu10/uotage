import { LoginForm } from "@/app/login/login-form";
import { publicEnv } from "@/lib/env";

export const metadata = { title: "ログイン | UOTAGE" };

export default function LoginPage() {
  const callbackUrl = `${publicEnv.appUrl.replace(/\/$/, "")}/auth/callback`;
  return <main className="public-card-page"><section>
    <p className="eyebrow">管理メニュー</p><h1>ログイン</h1>
    <p>招待済みのオペレーター用メールアドレスを入力してください。</p>
    <LoginForm supabaseUrl={publicEnv.supabaseUrl} anonKey={publicEnv.supabaseAnonKey} callbackUrl={callbackUrl} />
  </section></main>;
}
