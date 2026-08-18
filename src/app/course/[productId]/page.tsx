import { notFound } from "next/navigation";

import { isHttpUrl } from "@/lib/safe-url";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

/** 会員サイト（コース視聴ページ）。トークン検証 + 購入レコードの存在チェックを行う。 */
export default async function CoursePage({ params, searchParams }: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  if (!isUuid(productId) || !token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) notFound();

  const supabase = createAdminClient();
  const tenantId = defaultTenantId();

  const { data: reader } = await supabase.from("readers").select("id")
    .eq("tenant_id", tenantId).eq("access_token", token).maybeSingle();
  if (!reader) notFound();

  const { data: purchase } = await supabase.from("purchases").select("id")
    .eq("tenant_id", tenantId).eq("reader_id", reader.id).eq("product_id", productId).maybeSingle();
  if (!purchase) notFound();

  const { data: product } = await supabase.from("products").select("name, content_url")
    .eq("tenant_id", tenantId).eq("id", productId).maybeSingle();
  if (!product?.content_url || !isHttpUrl(product.content_url)) notFound();

  return (
    <main className="public-card-page"><section>
      <p className="eyebrow">会員サイト</p>
      <h1>{product.name}</h1>
      <div className="video-embed">
        <iframe src={product.content_url} title={product.name} allow="autoplay; fullscreen" allowFullScreen />
      </div>
    </section></main>
  );
}
