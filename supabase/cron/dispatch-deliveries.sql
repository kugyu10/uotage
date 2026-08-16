-- 事前に Vault へ project_url と cron_secret を登録してから実行する。
-- 秘密値をこのSQLやmigrationへ直接記載しないこと。
select cron.schedule(
  'dispatch-deliveries-every-minute', '* * * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dispatch-deliveries',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );$$
);
