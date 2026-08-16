import "server-only";

import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

export type ActiveOffer = {
  deadlineAt: string;
  bookingUrl: string;
  funnelName: string;
};

export async function findActiveOffer(slug: string, token: string, now = new Date()): Promise<ActiveOffer | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const supabase = createAdminClient();
  const tenantId = defaultTenantId();
  const { data: reader } = await supabase.from("readers").select("id")
    .eq("tenant_id", tenantId).eq("access_token", token).maybeSingle();
  if (!reader) return null;
  const { data: funnel } = await supabase.from("funnels").select("id, name, booking_url")
    .eq("tenant_id", tenantId).eq("slug", slug).eq("is_active", true).maybeSingle();
  if (!funnel?.booking_url) return null;
  const { data: scenario } = await supabase.from("scenarios").select("id")
    .eq("tenant_id", tenantId).eq("funnel_id", funnel.id).eq("is_active", true).limit(1).maybeSingle();
  if (!scenario) return null;
  const { data: enrollment } = await supabase.from("scenario_readers").select("deadline_at")
    .eq("tenant_id", tenantId).eq("reader_id", reader.id).eq("scenario_id", scenario.id)
    .eq("status", "active").maybeSingle();
  if (!enrollment || new Date(enrollment.deadline_at).getTime() <= now.getTime()) return null;
  return { deadlineAt: enrollment.deadline_at, bookingUrl: funnel.booking_url, funnelName: funnel.name };
}
