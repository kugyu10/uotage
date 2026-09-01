import { UnsubscribeForm } from "@/app/unsubscribe/unsubscribe-form";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "メルマガ解除 | UOTAGE" };

export default async function UnsubscribePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const token = typeof query.u === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(query.u) ? query.u : "";
  const readerResult = token ? await createAdminClient().from("readers")
    .select("unsubscribed_at")
    .eq("tenant_id", defaultTenantId())
    .eq("unsubscribe_token", token)
    .maybeSingle() : { data: null, error: null };
  const isAlreadyUnsubscribed = Boolean(readerResult.data?.unsubscribed_at);
  return <main className="public-card-page"><section>
    <h1>メルマガ解除</h1>
    {token && !readerResult.error ? <><p>{isAlreadyUnsubscribed ? "このメールアドレスはすでに配信停止済みです。" : "このメールアドレスへのステップ配信を停止します。"}</p><UnsubscribeForm token={token} alreadyUnsubscribed={isAlreadyUnsubscribed} /></>
      : <p>解除用リンクが正しくありません。</p>}
  </section></main>;
}
