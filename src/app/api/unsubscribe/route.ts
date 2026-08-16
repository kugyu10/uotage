import "server-only";

import { createAdminClient, defaultTenantId } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("u") ?? "";
  if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    const { error } = await createAdminClient().from("readers")
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq("tenant_id", defaultTenantId()).eq("unsubscribe_token", token)
      .is("unsubscribed_at", null);
    if (error) return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true });
}
