-- [DEPRECATED / ロールバック専用] 移行 #7 により、配信cronの起動元は
-- Cloudflare Workers Cron Trigger（workers/dispatch-cron）へ移行した。
-- このSQL（および `public.configure_delivery_cron` 経由でのpg_cron構成）は
-- 通常運用では使わない。Workers側に障害が起き、pg_cron経路へ緊急ロール
-- バックする場合にのみ、手順書（workers/dispatch-cron/README.md の
-- 「ロールバック手順」）に従って実行すること。
--
-- 実行前に必ず Workers Cron Trigger を無効化し、二重起動を避けること。
--
-- 実運用では `npm run deliveries:deploy -- --configure-pg-cron` が秘密を生成し、
-- このRPC経由でVaultとcronを同期する。秘密値をSQLへ直接記載しないこと。
select public.configure_delivery_cron(
  'https://your-project-ref.supabase.co',
  'replace-with-a-random-secret-of-at-least-32-characters'
);
