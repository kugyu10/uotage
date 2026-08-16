import { notFound } from "next/navigation";

import { RegistrationForm } from "@/app/lp/[slug]/registration-form";
import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function LandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { slug } = await params;
  const { path } = await searchParams;
  const registrationPath = typeof path === "string" ? path : null;
  const supabase = createAdminClient();
  const { data: funnel } = await supabase
    .from("funnels")
    .select("name, slug")
    .eq("tenant_id", defaultTenantId())
    .eq("slug", slug)
    .eq("trigger_type", "registration")
    .eq("is_active", true)
    .maybeSingle();

  if (!funnel) notFound();

  return (
    <main className="landing-page">
      <section>
        <p className="eyebrow">無料プレゼント</p>
        <h1>{funnel.name}</h1>
        <p>メールアドレスを登録すると、すぐにご案内をお送りします。</p>
        <RegistrationForm funnelSlug={funnel.slug} registrationPath={registrationPath} />
        <p className="legal">登録により、関連するご案内をメールでお届けします。いつでもメール内のリンクからメルマガ解除できます。</p>
        <p className="legal"><a href="/privacy">プライバシーポリシー</a></p>
      </section>
    </main>
  );
}
