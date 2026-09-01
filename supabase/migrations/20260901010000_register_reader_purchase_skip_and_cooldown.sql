-- コードレビュー指摘の2件に対応する register_reader v6。
--
-- 1) [最高] 新規登録の1通目が「購入済みには送らない」(4.3-4) を迂回していた。
--    v5 は重複登録の再送だけを配信ワーカーに寄せたが、新規登録
--    (had_enrollment = false) は今も API が直接 Resend を叩く。register_reader は
--    unsubscribed_at しか見ておらず、step.skip_if_purchased の判定は
--    claim_deliveries 側にしかなかったため、対象商品を購入済みの人が
--    そのファネルの LP に初めて登録すると1通目が送られていた。
--    さらに1通目は status='processing' で予約されるため、claim_deliveries が
--    後から拾ってスキップ判定を掛ける機会も無い。
--    v6: claim_deliveries と同じ判定をここでも行い、該当する場合は1通目を
--    最初から 'skipped' で確定させ、subject/body/initial_delivery_id を返さない。
--    登録トリガーのファネルだけを引くため、claim_deliveries 側の
--    「購入トリガーのシナリオは判定対象外」条件はここでは自明に成立する。
--
-- 2) [高] メールアドレス単位のレート制限が無く、登録連打で他人の受信箱へ
--    1通目を何度でも送りつけられた。API 側の制限は IP 単位かつ
--    インスタンスローカル(5回/分)で、Fluid Compute のスケールと
--    IP ローテーションで容易に回避できる。
--    v6: 1通目の再送は「直近の送信/予約から10分以上経っている」場合のみ。
--    インスタンス数に依存せず DB 側で確実に効く。二重送信の抑止ではなく
--    受信箱への連投抑止が目的なので、判定は (reader, scenario) 単位。
drop function public.register_reader(uuid, text, text, text, text, text, text);

create function public.register_reader(
  target_tenant_id uuid,
  target_funnel_slug text,
  reader_email text,
  reader_name text,
  target_registration_path text,
  generated_access_token text,
  generated_unsubscribe_token text
)
returns table (
  email text, name text, access_token text, unsubscribe_token text,
  funnel_slug text, deadline_at timestamptz, subject text, body text,
  initial_delivery_id uuid, product_id uuid,
  reader_id uuid, initial_grant_label_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- 1通目の再送を抑止するクールダウン。API 側の IP 単位制限と違い
  -- インスタンス数に依存しないため、これが実効的な下限になる。
  resend_cooldown constant interval := interval '10 minutes';
  selected_funnel public.funnels%rowtype;
  selected_scenario public.scenarios%rowtype;
  selected_reader public.readers%rowtype;
  enrollment public.scenario_readers%rowtype;
  path_label_id uuid;
  had_enrollment boolean;
  initial_step_id uuid;
  initial_skip_if_purchased boolean;
  initial_purchase_skip boolean;
begin
  select * into selected_funnel from public.funnels
    where tenant_id = target_tenant_id and slug = target_funnel_slug
      and trigger_type = 'registration' and is_active
    for share;
  if not found then raise exception 'active registration funnel not found'; end if;

  select * into selected_scenario from public.scenarios
    where tenant_id = target_tenant_id and funnel_id = selected_funnel.id and is_active
    order by created_at, id limit 1 for share;
  if not found then raise exception 'active scenario not found'; end if;

  insert into public.readers (tenant_id, email, name, access_token, unsubscribe_token)
  values (target_tenant_id, lower(reader_email), nullif(reader_name, ''), generated_access_token, generated_unsubscribe_token)
  on conflict (tenant_id, email) do update set
    name = coalesce(public.readers.name, excluded.name)
  returning * into selected_reader;

  select exists (
    select 1 from public.scenario_readers existing
    where existing.reader_id = selected_reader.id and existing.scenario_id = selected_scenario.id
  ) into had_enrollment;

  insert into public.scenario_readers
    (tenant_id, reader_id, scenario_id, registration_path, deadline_at)
  values
    (target_tenant_id, selected_reader.id, selected_scenario.id, target_registration_path,
     now() + make_interval(hours => selected_funnel.deadline_hours))
  on conflict (reader_id, scenario_id) do update set reader_id = excluded.reader_id
  returning * into enrollment;

  if target_registration_path is not null then
    select label_id into path_label_id from public.registration_paths
      where tenant_id = target_tenant_id and funnel_id = selected_funnel.id
        and path = target_registration_path;
    if not found then raise exception 'registration path not found'; end if;
    if path_label_id is not null then
      insert into public.reader_labels (tenant_id, reader_id, label_id)
      values (target_tenant_id, selected_reader.id, path_label_id)
      on conflict (reader_id, label_id) do nothing;
    end if;
  end if;

  select initial.id, initial.skip_if_purchased
    into initial_step_id, initial_skip_if_purchased
    from public.step_messages initial
    where initial.tenant_id = target_tenant_id
      and initial.scenario_id = selected_scenario.id and initial.delay_minutes = 0
    order by initial.position, initial.id limit 1;

  -- 「購入済みには送らない」(4.3-4)。1通目は claim_deliveries の送信条件
  -- フィルタを通らないため、同じ判定をここで行う。対象商品が設定されて
  -- いればその購入のみ、未設定ならテナント内のいずれかの購入でスキップ。
  initial_purchase_skip := coalesce(initial_skip_if_purchased, false) and exists (
    select 1 from public.purchases purchase
    where purchase.tenant_id = target_tenant_id
      and purchase.reader_id = selected_reader.id
      and (selected_funnel.product_id is null or purchase.product_id = selected_funnel.product_id)
  );

  -- 解除済み読者にはキューを一切積まない(共通フィルタの前段)。
  if selected_reader.unsubscribed_at is null then
    insert into public.deliveries
      (tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at, status, error_message)
    select target_tenant_id, enrollment.id, step.id, selected_reader.id,
      case when step.send_at_hour is null then
        enrollment.registered_at + make_interval(mins => step.delay_minutes)
      else
        (((enrollment.registered_at + make_interval(mins => step.delay_minutes)) at time zone 'Asia/Tokyo')::date
          + make_time(step.send_at_hour, 0, 0)) at time zone 'Asia/Tokyo'
      end,
      case
        when step.id = initial_step_id and initial_purchase_skip then 'skipped'
        when step.id = initial_step_id then 'processing'
        else 'queued'
      end,
      case when step.id = initial_step_id and initial_purchase_skip
        then 'delivery condition not met' end
    from public.step_messages step
    where step.tenant_id = target_tenant_id and step.scenario_id = selected_scenario.id
    on conflict (scenario_reader_id, step_message_id) do nothing;

    -- 重複登録(4.1-2): 期限はリセットせず、1通目を queued + scheduled_at=now() で
    -- 積み直す。送信条件フィルタと排他制御を持つ配信ワーカーだけが送信する。
    -- 送信中(processing)の行には触れない。
    -- 直近の送信/予約から resend_cooldown 未満なら積み直さない(連投抑止)。
    if had_enrollment and initial_step_id is not null then
      update public.deliveries delivery set
        status = 'queued', scheduled_at = now(), processing_started_at = null, error_message = null
      where delivery.scenario_reader_id = enrollment.id
        and delivery.step_message_id = initial_step_id
        and delivery.status in ('sent', 'queued', 'failed', 'skipped')
        and coalesce(delivery.sent_at, delivery.scheduled_at) <= now() - resend_cooldown;
    end if;
  end if;

  -- 即時送信の材料(subject/body/initial_delivery_id)は
  -- 「新規登録」かつ「購入済みスキップに該当しない」場合のみ返す。
  return query select selected_reader.email, selected_reader.name,
    selected_reader.access_token, selected_reader.unsubscribe_token,
    selected_funnel.slug, enrollment.deadline_at, first_step.subject, first_step.body,
    first_step.delivery_id, selected_funnel.product_id,
    selected_reader.id, first_step.grant_label_id
  from (select step.subject, step.body, step.grant_label_id, delivery.id as delivery_id
        from public.step_messages step
        join public.deliveries delivery on delivery.step_message_id = step.id
          and delivery.scenario_reader_id = enrollment.id
        where step.tenant_id = target_tenant_id and step.scenario_id = selected_scenario.id
          and step.delay_minutes = 0
          and selected_reader.unsubscribed_at is null
          and not had_enrollment
          and not initial_purchase_skip
        order by step.position, step.id limit 1) first_step
  right join (select 1) singleton on true;
end;
$$;

revoke all on function public.register_reader(uuid, text, text, text, text, text, text) from public;
grant execute on function public.register_reader(uuid, text, text, text, text, text, text) to service_role;
