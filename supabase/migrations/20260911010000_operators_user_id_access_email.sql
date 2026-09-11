-- #9: 管理画面の認証を Supabase Auth（Magic Link）から Cloudflare Access へ移行。
--
-- 決定事項（Issue #9 注意点の「移行キーをメールアドレスにするか安定IDにするか」）:
--   operators.user_id は auth.users(id) の UUID から、Cloudflare Access JWT の
--   `email` クレーム（text）へ切り替える。理由:
--     - Access の許可（アプリの Policy）自体がメールアドレス単位で管理される運用と
--       一致し、運用者にとって分かりやすい。
--     - sub クレームは IdP/接続方法により再発行され得るが、email は
--       Access のポリシーが最終的に検証している値そのもの。
--   RLS ポリシー（auth.uid() 前提）の撤去は P5 の範囲。ここでは型不整合で
--   マイグレーションが失敗しないよう is_tenant_operator() 側だけ最小限直す。
--   authenticated ロールの Supabase セッションはもう発行されないため、
--   このポリシー自体は「無害」ではなく「常に false を返す」＝当該ポリシーが
--   保護する行は authenticated ロールから見て常に全拒否になる（実害は無い。
--   service role が使われるため）。
--
-- 【重要】このマイグレーション適用直後、既存行の user_id は旧UUIDが text化
-- されただけの無効な値のままなので、下記の手動UPDATEを実行するまで
-- /admin 配下は全ページ 404（requireOperator 未登録扱い）になる。
-- 適用と手動UPDATEは連続して実施すること（間はダウンタイム）。
-- user_id は大文字小文字を正規化して小文字で入れる（アプリ側の比較も
-- toLowerCase() している。src/lib/supabase/server.ts 参照）:
--   update public.operators set user_id = lower('you@example.com') where id = '<uuid>';

alter table public.operators
  drop constraint if exists operators_user_id_fkey;

alter table public.operators
  alter column user_id type text using user_id::text;

comment on column public.operators.user_id is
  'Cloudflare Access JWT の email クレーム（小文字で正規化。旧: auth.users(id) の UUID）。移行直後の値は要手動更新（上記コメント参照）。';

create or replace function public.is_tenant_operator(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.operators
    where tenant_id = target_tenant_id
      and user_id = auth.uid()::text
  );
$$;

-- #9 レビュー#2 🟡-3: requireOperator() は Cloudflare Access 移行に伴い
-- service_role クライアントを返すようになった（authenticated ロールのセッションは
-- もう発行されない）。append_step_message / move_step_message は
-- 20260901030000_step_message_ordering_rpc.sql で authenticated にのみ EXECUTE を
-- 付与しており、service_role からは alter default privileges 次第で権限拒否になり得る。
-- 他の全RPC（register_reader / import_scenario_readers / claim_deliveries /
-- process_stripe_purchase / configure_delivery_cron 等）と同じく、呼ぶロールへ
-- 明示的に付与する（冪等・無害）。
grant execute on function public.append_step_message(uuid) to service_role;
grant execute on function public.move_step_message(uuid, uuid, text) to service_role;
