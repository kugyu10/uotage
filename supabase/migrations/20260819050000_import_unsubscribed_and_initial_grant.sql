-- 反証レビュー第2ラウンドの残り2欠陥に対応する。
--
-- 1) CSVインポートが「解除状況」列を破棄し、解除済み読者に全ステップを
--    再送していた (10.2 / 4.3-4 違反)。解除済みの行は unsubscribed_at を
--    設定し(既存の解除日時は维持)、deliveries も積まない。
--
-- 2) 登録フォーム経由の1通目はAPIが即時送信するため、配信ワーカーの
--    「送信後に付与するラベル」処理を通らない。register_reader の返却に
--    reader_id と1通目の grant_label_id を追加し、API側で付与できるようにする。

create or replace function public.import_scenario_readers(
  target_tenant_id uuid,
  target_scenario_id uuid,
  delivery_mode text,
  target_registered_at timestamptz,
  rows jsonb
)
returns table (
  created_readers integer,
  updated_readers integer,
  new_enrollments integer,
  skipped_enrollments integer,
  deliveries_queued integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_scenario public.scenarios%rowtype;
  selected_funnel public.funnels%rowtype;
  execution_time timestamptz := now();
  row_data jsonb;
  selected_reader public.readers%rowtype;
  enrollment public.scenario_readers%rowtype;
  label_name text;
  trimmed_label text;
  found_label_id uuid;
  row_unsubscribed boolean;
  computed_registered_at timestamptz;
  computed_deadline_at timestamptz;
  created_count integer := 0;
  updated_count integer := 0;
  new_enrollment_count integer := 0;
  skipped_enrollment_count integer := 0;
  queued_count integer := 0;
  inserted_deliveries integer;
begin
  if delivery_mode not in ('none', 'from_now', 'from_start') then
    raise exception 'invalid delivery_mode: %', delivery_mode;
  end if;
  if delivery_mode = 'from_now' and target_registered_at is null then
    raise exception 'target_registered_at is required for delivery_mode = from_now';
  end if;

  select * into selected_scenario from public.scenarios
    where tenant_id = target_tenant_id and id = target_scenario_id
    for share;
  if not found then
    raise exception 'scenario not found for tenant';
  end if;

  if selected_scenario.funnel_id is not null then
    select * into selected_funnel from public.funnels
      where tenant_id = target_tenant_id and id = selected_scenario.funnel_id;
  end if;

  for row_data in select * from jsonb_array_elements(rows)
  loop
    row_unsubscribed := coalesce((row_data->>'unsubscribed')::boolean, false);

    -- 1) readers を upsert する（既存は更新扱い、トークンと既存の解除日時は維持）。
    select * into selected_reader from public.readers
      where tenant_id = target_tenant_id and email = lower(row_data->>'email')
      for update;

    if found then
      update public.readers set
        name = coalesce(nullif(row_data->>'name', ''), name),
        custom_fields = custom_fields || coalesce(row_data->'custom_fields', '{}'::jsonb),
        unsubscribed_at = case when row_unsubscribed then coalesce(unsubscribed_at, execution_time) else unsubscribed_at end
      where tenant_id = target_tenant_id and id = selected_reader.id
      returning * into selected_reader;
      updated_count := updated_count + 1;
    else
      insert into public.readers (tenant_id, email, name, custom_fields, access_token, unsubscribe_token, unsubscribed_at)
      values (
        target_tenant_id,
        lower(row_data->>'email'),
        nullif(row_data->>'name', ''),
        coalesce(row_data->'custom_fields', '{}'::jsonb),
        row_data->>'access_token',
        row_data->>'unsubscribe_token',
        case when row_unsubscribed then execution_time else null end
      )
      returning * into selected_reader;
      created_count := created_count + 1;
    end if;

    -- 2) CSVのラベル列: 存在しないラベルは自動作成して付与する。
    for label_name in select jsonb_array_elements_text(coalesce(row_data->'labels', '[]'::jsonb))
    loop
      trimmed_label := trim(label_name);
      if length(trimmed_label) = 0 then
        continue;
      end if;

      insert into public.labels (tenant_id, name)
      values (target_tenant_id, trimmed_label)
      on conflict (tenant_id, name) do nothing;

      select id into found_label_id from public.labels
        where tenant_id = target_tenant_id and name = trimmed_label;

      insert into public.reader_labels (tenant_id, reader_id, label_id)
      values (target_tenant_id, selected_reader.id, found_label_id)
      on conflict (reader_id, label_id) do nothing;
    end loop;

    -- 3) 再送防止オプションに応じて registered_at / deadline_at を決定する。
    if delivery_mode = 'from_now' then
      computed_registered_at := target_registered_at;
    else
      -- 'none' と 'from_start' は新規読者と同じ扱い（実行時刻を登録日時とする）。
      computed_registered_at := execution_time;
    end if;

    if selected_funnel.id is not null then
      computed_deadline_at := computed_registered_at + make_interval(hours => selected_funnel.deadline_hours);
    else
      computed_deadline_at := computed_registered_at;
    end if;

    -- 4) scenario_readers は冪等（既に登録済みなら期限をリセットせずスキップ）。
    insert into public.scenario_readers
      (tenant_id, reader_id, scenario_id, registration_path, registered_at, deadline_at)
    values (
      target_tenant_id,
      selected_reader.id,
      target_scenario_id,
      nullif(row_data->>'registration_path', ''),
      computed_registered_at,
      computed_deadline_at
    )
    on conflict (reader_id, scenario_id) do nothing
    returning * into enrollment;

    if enrollment.id is null then
      -- 既にこのシナリオに登録済み。deliveries も一切積まずスキップする。
      skipped_enrollment_count := skipped_enrollment_count + 1;
      continue;
    end if;

    new_enrollment_count := new_enrollment_count + 1;

    -- 5) 「ステップ配信の対象にしない」以外は deliveries をキューに積む。
    --    解除済み読者には積まない（配信フィルタの前段で除外する）。
    --    register_reader と同じ Asia/Tokyo 丸めロジックで scheduled_at を計算し、
    --    「途中から配信する」では実行時刻より後のステップのみ積む。
    if delivery_mode <> 'none' and selected_reader.unsubscribed_at is null then
      with steps as (
        select
          step.id,
          case when step.send_at_hour is null then
            enrollment.registered_at + make_interval(mins => step.delay_minutes)
          else
            (
              ((enrollment.registered_at + make_interval(mins => step.delay_minutes)) at time zone 'Asia/Tokyo')::date
              + make_time(step.send_at_hour, 0, 0)
            ) at time zone 'Asia/Tokyo'
          end as computed_scheduled_at
        from public.step_messages step
        where step.tenant_id = target_tenant_id and step.scenario_id = target_scenario_id
      ),
      inserted as (
        insert into public.deliveries (tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at, status)
        select
          target_tenant_id,
          enrollment.id,
          steps.id,
          selected_reader.id,
          steps.computed_scheduled_at,
          'queued'
        from steps
        where delivery_mode = 'from_start' or steps.computed_scheduled_at > execution_time
        on conflict (scenario_reader_id, step_message_id) do nothing
        returning 1
      )
      select count(*) into inserted_deliveries from inserted;
      queued_count := queued_count + inserted_deliveries;
    end if;
  end loop;

  return query select created_count, updated_count, new_enrollment_count, skipped_enrollment_count, queued_count;
end;
$$;

revoke all on function public.import_scenario_readers(uuid, uuid, text, timestamptz, jsonb) from public;
grant execute on function public.import_scenario_readers(uuid, uuid, text, timestamptz, jsonb) to service_role;

-- register_reader: 返却に reader_id と1通目の grant_label_id を追加する。
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
  selected_funnel public.funnels%rowtype;
  selected_scenario public.scenarios%rowtype;
  selected_reader public.readers%rowtype;
  enrollment public.scenario_readers%rowtype;
  path_label_id uuid;
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

  insert into public.deliveries
    (tenant_id, scenario_reader_id, step_message_id, reader_id, scheduled_at, status)
  select target_tenant_id, enrollment.id, step.id, selected_reader.id,
    case when step.send_at_hour is null then
      enrollment.registered_at + make_interval(mins => step.delay_minutes)
    else
      (((enrollment.registered_at + make_interval(mins => step.delay_minutes)) at time zone 'Asia/Tokyo')::date
        + make_time(step.send_at_hour, 0, 0)) at time zone 'Asia/Tokyo'
    end,
    case when step.id = (
      select initial.id from public.step_messages initial
      where initial.tenant_id = target_tenant_id
        and initial.scenario_id = selected_scenario.id and initial.delay_minutes = 0
      order by initial.position, initial.id limit 1
    ) then 'processing' else 'queued' end
  from public.step_messages step
  where step.tenant_id = target_tenant_id and step.scenario_id = selected_scenario.id
  on conflict (scenario_reader_id, step_message_id) do nothing;

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
        order by step.position, step.id limit 1) first_step
  right join (select 1) singleton on true;
end;
$$;

revoke all on function public.register_reader(uuid, text, text, text, text, text, text) from public;
grant execute on function public.register_reader(uuid, text, text, text, text, text, text) to service_role;
