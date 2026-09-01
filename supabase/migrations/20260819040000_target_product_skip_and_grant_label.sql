-- 反証レビュー第2ラウンドの2欠陥に対応する。
--
-- 1) 「購入済みには送らない」(4.3-4) の判定対象を「対象商品」に戻す。
--    登録トリガーのファネルにも任意で対象商品(訴求する商品)を持てるように
--    制約を撤廃し、対象商品が設定されていればその購入のみ、未設定なら
--    テナント内のいずれかの購入でスキップする。購入トリガーのシナリオは
--    読者全員が購入者のため従来どおり判定対象外。
--
-- 2) 「送信後に付与するラベル」(4.2.2 アクション管理) を配信ワーカーが
--    実行できるよう、claim_deliveries の返却に tenant_id / reader_id /
--    grant_label_id を追加する。
alter table public.funnels drop constraint if exists funnels_registration_forbids_product;
comment on column public.funnels.product_id is
  '購入トリガー: 起点となる商品(必須)。登録トリガー: 訴求する対象商品(任意。購入済みには送らないの判定対象)';

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
            left join public.funnels target_funnel on target_funnel.id = scenario.funnel_id
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
