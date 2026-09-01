-- skip_if_purchased の判定を修正する。
-- 旧述語は purchases を funnels.product_id で結合していたが、登録トリガーの
-- ファネルは制約 funnels_registration_forbids_product により product_id が
-- 必ず NULL のため、条件が恒偽になり購入済み読者へ期限訴求メールが送られていた。
-- スキーマに「登録ファネルの対象商品」を表す列が無い MVP では、
-- 購入トリガー以外のシナリオについて「テナント内でいずれかの商品を購入済み」
-- ならスキップする（4.3-4 の事故防止フィルタとしての最小解釈）。
-- 購入トリガーのシナリオは読者全員が購入者なので、この判定の対象外とする。
drop function public.claim_deliveries(integer, uuid);

create function public.claim_deliveries(batch_limit integer default 500, target_delivery_id uuid default null)
returns table (
  delivery_id uuid, attempt_count integer, recipient text, reader_name text,
  access_token text, unsubscribe_token text, subject text, body text,
  from_name text, from_email text, legal_footer text, funnel_slug text,
  booking_url text, deadline_at timestamptz, product_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_time timestamptz := clock_timestamp();
begin
  if batch_limit < 1 or batch_limit > 500 then raise exception 'batch_limit must be between 1 and 500'; end if;

  update public.deliveries delivery set
    status = case when delivery.attempt_count >= 3 then 'failed' else 'queued' end,
    processing_started_at = null,
    error_message = case when delivery.attempt_count >= 3 then 'processing timeout after maximum retries' else delivery.error_message end
  where delivery.status = 'processing'
    and (delivery.processing_started_at < now() - interval '10 minutes'
      or (delivery.processing_started_at is null and delivery.scheduled_at < now() - interval '10 minutes'));

  with candidates as (
    select delivery.id from public.deliveries delivery
    where delivery.status = 'queued' and delivery.scheduled_at <= now()
      and (target_delivery_id is null or delivery.id = target_delivery_id)
    order by delivery.scheduled_at, delivery.id
    for update skip locked limit batch_limit
  )
  update public.deliveries delivery set status = 'processing',
      processing_started_at = claim_time, attempt_count = delivery.attempt_count + 1,
      error_message = null
    from candidates where delivery.id = candidates.id;

  update public.deliveries delivery set status = 'skipped', processing_started_at = null,
      error_message = 'delivery condition not met'
    from public.readers reader, public.scenario_readers enrollment,
      public.step_messages step, public.scenarios scenario
    where delivery.status = 'processing' and delivery.processing_started_at = claim_time
      and reader.id = delivery.reader_id
      and enrollment.id = delivery.scenario_reader_id and step.id = delivery.step_message_id
      and scenario.id = enrollment.scenario_id
      and (reader.unsubscribed_at is not null or enrollment.status in ('stopped', 'completed')
        or (step.skip_if_purchased
          and not exists (
            select 1 from public.funnels funnel
            where funnel.id = scenario.funnel_id and funnel.trigger_type = 'purchase'
          )
          and exists (
            select 1 from public.purchases purchase
            where purchase.tenant_id = delivery.tenant_id and purchase.reader_id = reader.id
          )));

  return query select delivery.id, delivery.attempt_count, reader.email, reader.name,
    reader.access_token, reader.unsubscribe_token, step.subject, step.body,
    account.from_name, account.from_email, account.legal_footer,
    funnel.slug, funnel.booking_url, enrollment.deadline_at, funnel.product_id
  from public.deliveries delivery
  join public.readers reader on reader.id = delivery.reader_id
  join public.scenario_readers enrollment on enrollment.id = delivery.scenario_reader_id
  join public.step_messages step on step.id = delivery.step_message_id
  join public.scenarios scenario on scenario.id = enrollment.scenario_id
  join public.delivery_accounts account on account.id = scenario.delivery_account_id
  left join public.funnels funnel on funnel.id = scenario.funnel_id
  where delivery.status = 'processing' and delivery.processing_started_at = claim_time
  order by delivery.scheduled_at, delivery.id;
end;
$$;

revoke all on function public.claim_deliveries(integer, uuid) from public;
grant execute on function public.claim_deliveries(integer, uuid) to service_role;
