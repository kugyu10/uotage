import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env";

/** RLS を通さない、公開 API / バッチ専用の Supabase クライアント。 */
export function createAdminClient() {
  return createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function defaultTenantId(): string {
  const value = process.env.DEFAULT_TENANT_ID;
  if (!value) {
    throw new Error(
      "環境変数 DEFAULT_TENANT_ID が未設定です。.env.local を確認してください。",
    );
  }
  return value;
}
