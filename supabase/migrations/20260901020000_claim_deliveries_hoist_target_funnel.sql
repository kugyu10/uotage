-- コードレビュー指摘 [中] への対応。挙動は変えない読みやすさの修正。
--
-- 「購入済みには送らない」の判定対象商品を解決する left join が、purchases を
-- 起点にした相関 EXISTS の中に置かれていたため、「funnel_id が null なら
-- target_funnel が null になり product_id is null が真 → テナント内のどの購入でも
-- スキップ」という意図が結合の副作用としてしか読めなかった。
-- left join を UPDATE の FROM 最上位へ出し、最終 return query と同じ形に揃える。
-- 結合は scenario 1行に対して高々1行(funnels への FK があるため)なので、
-- 判定結果は従来と同一。
drop function public.claim_deliveries(integer, uuid);

create function public.claim_deliveries(batch_limit integer default 500, target_delivery_id uuid default null)
returns table (
  delivery_id uuid, attempt_count integer, recipient text, reader_name text,
  access_token text, unsubscribe_token text, subject text, body text,
  from_name text, from_email text, legal_footer text, funnel_slug text,
  booking_url text, deadline_at timestamptz, product_id uuid,
  tenant_id uuid, reader_id uuid, grant_label_id uuid
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
      public.step_messages step,
      public.scenarios scenario
        left join public.funnels target_funnel on target_funnel.id = scenario.funnel_id
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
          -- target_funnel.product_id is null は「対象商品が未設定」
          -- (= scenario.funnel_id が null、または設定なし) を意味し、その場合は
          -- テナント内のいずれかの購入でスキップする。
          and exists (
            select 1 from public.purchases purchase
            where purchase.tenant_id = delivery.tenant_id and purchase.reader_id = reader.id
              and (target_funnel.product_id is null or purchase.product_id = target_funnel.product_id)
          )));

  return query select delivery.id, delivery.attempt_count, reader.email, reader.name,
    reader.access_token, reader.unsubscribe_token, step.subject, step.body,
    account.from_name, account.from_email, account.legal_footer,
    funnel.slug, funnel.booking_url, enrollment.deadline_at, funnel.product_id,
    delivery.tenant_id, delivery.reader_id, step.grant_label_id
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
