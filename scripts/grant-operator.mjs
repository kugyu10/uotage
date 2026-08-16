import { createClient } from "@supabase/supabase-js";

const email = process.argv[2]?.trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "")) {
  console.error("usage: node --env-file=.env.local scripts/grant-operator.mjs <email> [--confirm]");
  process.exit(64);
}
for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEFAULT_TENANT_ID"]) {
  if (!process.env[name]) throw new Error(`${name} が未設定です`);
}
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) throw error;
const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
if (!user) throw new Error("対象ユーザーが見つかりません。先にSupabase Authで手動作成または招待してください。");
console.log(`user=${user.id}\ntenant=${process.env.DEFAULT_TENANT_ID}\nrole=owner`);
if (!process.argv.includes("--confirm")) {
  console.error("確認後に --confirm を付けて実行してください。");
  process.exit(66);
}
const { error: upsertError } = await supabase.from("operators").upsert({
  tenant_id: process.env.DEFAULT_TENANT_ID, user_id: user.id, role: "owner", permissions: {},
}, { onConflict: "tenant_id,user_id" });
if (upsertError) throw upsertError;
console.log("オペレーター権限を付与しました。");
