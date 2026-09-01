import { createClient } from "@supabase/supabase-js";

for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEFAULT_TENANT_ID"]) {
  if (!process.env[name]) throw new Error(`${name} が未設定です`);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.env.DEFAULT_TENANT_ID)) {
  throw new Error("DEFAULT_TENANT_ID はUUIDではありません。初期化コマンドの出力値へ置き換えてください。");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await supabase.from("tenants").select("id").eq("id", process.env.DEFAULT_TENANT_ID).maybeSingle();
if (error) throw new Error(`Supabase接続またはスキーマ確認に失敗しました: ${error.message}`);
const { error: registrationPathError } = await supabase
  .from("registration_paths")
  .select("id", { head: true, count: "exact" })
  .limit(1);
if (registrationPathError) {
  throw new Error(`registration_paths の確認に失敗しました: ${registrationPathError.message}`);
}
console.log(data
  ? "Supabase接続OK: DEFAULT_TENANT_ID と registration_paths は存在します。"
  : "Supabase接続OK: registration_paths は存在しますが、DEFAULT_TENANT_ID が存在しません。");
