create or replace function public.process_stripe_purchase(
  target_tenant_id uuid, product uuid, stripe_session text, buyer_email text,
  buyer_name text, paid_amount integer, purchased_timestamp timestamptz,
  generated_access_token text, generated_unsubscribe_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_product public.products%rowtype;
  selected_funnel public.funnels%rowtype;
  selected_reader public.readers%rowtype;
  selected_scenario public.scenarios%rowtype;
  enrollment public.scenario_readers%rowtype;
begin
  -- Stripe再送時は、既に完了したトランザクションへ一切手を加えない。
  if exists (select 1 from public.purchases where stripe_session_id = stripe_session) then return; end if;
  select * into selected_product from public.products
    where tenant_id = target_tenant_id and id = product for share;
  if not found then raise exception 'product not found'; end if;

  insert into public.readers (tenant_id, email, name, access_token, unsubscribe_token)
  values (target_tenant_id, lower(buyer_email), nullif(buyer_name, ''), generated_access_token, generated_unsubscribe_token)
  on conflict (tenant_id, email) do update set name = coalesce(public.readers.name, excluded.name)
  returning * into selected_reader;

  insert into public.purchases (tenant_id, reader_id, product_id, stripe_session_id, amount, purchased_at)
  values (target_tenant_id, selected_reader.id, product, stripe_session, paid_amount, purchased_timestamp)
  on conflict (stripe_session_id) do nothing;
  if not found then return; end if;

  if selected_product.post_purchase_label_id is not null then
    insert into public.reader_labels (tenant_id, reader_id, label_id)
    values (target_tenant_id, selected_reader.id, selected_product.post_purchase_label_id)
    on conflict (reader_id, label_id) do nothing;
  end if;
  if selected_product.post_purchase_scenario_id is null then return; end if;
  select * into selected_scenario from public.scenarios
    where tenant_id = target_tenant_id and id = selected_product.post_purchase_scenario_id and is_active for share;
  if not found then raise exception 'post-purchase scenario not found'; end if;
  select * into selected_funnel from public.funnels
    where tenant_id = target_tenant_id and id = selected_scenario.funnel_id
      and trigger_type = 'purchase' and product_id = product and is_active for share;
  if not found then raise exception 'active purchase funnel not found'; end if;

  insert into public.scenario_readers
    (tenant_id, reader_id, scenario_id, registration_path, registered_at, deadline_at)
  values (target_tenant_id, selected_reader.id, selected_scenario.id, 'stripe', purchased_timestamp,
    purchased_timestamp + make_interval(hours => selected_funnel.deadline_hours))
  on conflict (reader_id, scenario_id) do update set reader_id = excluded.reader_id
  returning * into enrollment;

  insert into public.deliveries
    (tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at)
  select target_tenant_id, enrollment.id, step.id, selected_reader.id,
    case when step.send_at_hour is null then enrollment.registered_at + make_interval(mins => step.delay_minutes)
    else (((enrollment.registered_at + make_interval(mins => step.delay_minutes)) at time zone 'Asia/Tokyo')::date
      + make_time(step.send_at_hour, 0, 0)) at time zone 'Asia/Tokyo' end
  from public.step_messages step
  where step.tenant_id = target_tenant_id and step.scenario_id = selected_scenario.id
  on conflict (scenario_reader_id, step_message_id) do nothing;
end;
$$;

revoke all on function public.process_stripe_purchase(uuid, uuid, text, text, text, integer, timestamptz, text, text) from public;
grant execute on function public.process_stripe_purchase(uuid, uuid, text, text, text, integer, timestamptz, text, text) to service_role;
