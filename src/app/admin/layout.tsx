import Link from "next/link";

import { requireOperator } from "@/lib/supabase/server";

const navigation = [
  ["ファネル", "/admin"], ["メール配信", "/admin/mail"], ["会員サイト", "/admin/courses"],
  ["ラベル", "/admin/labels"], ["管理メニュー", "/admin/settings"],
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireOperator();
  return <div className="admin-shell"><header><strong>UOTAGE</strong><nav>
    {navigation.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
  </nav></header>{children}</div>;
}
