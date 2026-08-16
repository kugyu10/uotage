import { publicEnv } from "@/lib/env";

export const metadata = { title: "プライバシーポリシー | UOTAGE" };

export default function PrivacyPage() {
  const operator = process.env.NEXT_PUBLIC_OPERATOR_NAME || "運営者情報を設定してください";
  const contact = process.env.NEXT_PUBLIC_CONTACT_EMAIL || "連絡先メールアドレスを設定してください";
  const address = process.env.NEXT_PUBLIC_OPERATOR_ADDRESS || "所在地を設定してください";

  return (
    <main className="policy-page">
      <h1>プライバシーポリシー</h1>
      <p>{operator}（以下「当方」）は、登録フォームで取得した氏名・メールアドレスを、プレゼントの提供および関連するご案内の配信のために利用します。</p>
      <p>ご本人の同意または法令上の根拠がある場合を除き、個人情報を第三者へ提供しません。メール配信は各メール内のメルマガ解除リンクからいつでも停止できます。</p>
      <h2>お問い合わせ先</h2>
      <p>運営者名：{operator}<br />所在地：{address}<br />メールアドレス：{contact}</p>
      <p><a href={publicEnv.appUrl}>トップへ戻る</a></p>
    </main>
  );
}
