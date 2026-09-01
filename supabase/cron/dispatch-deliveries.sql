-- 実運用では `npm run deliveries:deploy` が秘密を生成し、このRPC経由で
-- Vaultとcronを同期する。秘密値をSQLへ直接記載しないこと。
select public.configure_delivery_cron(
  'https://your-project-ref.supabase.co',
  'replace-with-a-random-secret-of-at-least-32-characters'
);
