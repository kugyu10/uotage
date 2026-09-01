create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function public.configure_delivery_cron(
  p_project_url text,
  p_cron_secret text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_project_url text := rtrim(p_project_url, '/');
  project_secret_id uuid;
  cron_secret_id uuid;
  existing_job_id bigint;
  configured_job_id bigint;
begin
  if normalized_project_url is null or normalized_project_url !~ '^https://[a-z0-9]+[.]supabase[.]co$' then
    raise exception 'invalid Supabase project URL';
  end if;
  if p_cron_secret is null or length(p_cron_secret) < 32 or length(p_cron_secret) > 512 or p_cron_secret ~ '[\r\n]' then
    raise exception 'invalid cron secret';
  end if;

  select secret.id into project_secret_id
  from vault.secrets secret
  where secret.name = 'project_url';

  if project_secret_id is null then
    perform vault.create_secret(
      normalized_project_url,
      'project_url',
      'UOTAGE delivery worker project URL'
    );
  else
    perform vault.update_secret(
      project_secret_id,
      normalized_project_url,
      'project_url',
      'UOTAGE delivery worker project URL'
    );
  end if;

  select secret.id into cron_secret_id
  from vault.secrets secret
  where secret.name = 'cron_secret';

  if cron_secret_id is null then
    perform vault.create_secret(
      p_cron_secret,
      'cron_secret',
      'UOTAGE delivery worker authorization secret'
    );
  else
    perform vault.update_secret(
      cron_secret_id,
      p_cron_secret,
      'cron_secret',
      'UOTAGE delivery worker authorization secret'
    );
  end if;

  select job.jobid into existing_job_id
  from cron.job job
  where job.jobname = 'dispatch-deliveries-every-minute';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  select cron.schedule(
    'dispatch-deliveries-every-minute',
    '* * * * *',
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dispatch-deliveries',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
      ) as request_id;
    $cron$
  ) into configured_job_id;

  return configured_job_id;
end;
$$;

revoke all on function public.configure_delivery_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_delivery_cron(text, text) to service_role;
