import { notFound } from "next/navigation";

import { requireOperator } from "@/lib/supabase/server";

const sections: Record<string, { eyebrow: string; title: string; description: string }> = {
  mail: { eyebrow: "メール配信", title: "シナリオ・ステップ配信", description: "配信アカウント配下のシナリオ、読者一覧、ステップ配信、送信済を管理します。" },
  courses: { eyebrow: "会員サイト", title: "コース・受講生", description: "商品に紐づくコースと受講生を確認します。" },
  labels: { eyebrow: "ラベル", title: "ラベル管理", description: "テナント内で共通利用するラベルを管理します。" },
  settings: { eyebrow: "管理メニュー", title: "オペレーター・配信アカウント", description: "オペレーター権限、差出人、法定フッター、決済連携を設定します。" },
};

export default async function AdminSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params; const content = sections[section]; if (!content) notFound();
  await requireOperator();
  return <main className="admin-main"><p className="eyebrow">{content.eyebrow}</p><h1>{content.title}</h1>
    <section className="admin-panel"><p>{content.description}</p><p>実データの編集機能は次の実装段階で追加します。</p></section></main>;
}
