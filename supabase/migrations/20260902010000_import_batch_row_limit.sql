-- コードレビュー指摘（高）: CSVインポートが全行を1トランザクションで処理していた。
--
-- アプリ側は確定実行を IMPORT_BATCH_SIZE (=500) 件ずつのRPC呼び出しに分割したが、
-- DB側にも上限を置いて契約を明示する。1バッチ = 1トランザクションなので、
-- 途中のバッチで失敗しても成功済みのバッチはコミット済みのまま残る。
-- 再実行が安全であることは既存の ON CONFLICT DO NOTHING 群が担保している
-- （readers は upsert、scenario_readers / reader_labels / deliveries は競合時に何もしない）。
--
-- 関数本体は 20260819050000 に対して以下の2点だけを変更している。
--   1) 1回の呼び出しの行数ガード（>1000行で raise exception）
--   2) delivery_mode='none'/'from_start' の registered_at を
--      coalesce(target_registered_at, now()) にする。バッチごとに now() を取ると
--      registered_at / deadline_at がバッチ間で数秒ずれるため、呼び出し側が渡した
--      1つの時刻を全バッチで共有できるようにする（未指定なら従来どおり now()）。

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
  -- 1回の呼び出しで受け付ける行数の上限。
  -- この関数は行ごとに `select ... for update` とラベル解決を回すため、数万行を
  -- 1トランザクションで渡すと statement timeout に当たる。アプリ側
  -- (src/lib/csv/import-batches.ts IMPORT_BATCH_SIZE = 500) は分割して呼び出すが、
  -- 将来の呼び出し元が分割を忘れたときに黙って遅くなるのではなく即座に失敗させる。
  if jsonb_array_length(rows) > 1000 then
    raise exception 'too many rows in one call: % (max 1000, split the import into batches)', jsonb_array_length(rows);
  end if;

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
      -- 'none' と 'from_start' は新規読者と同じ扱い（登録日時＝取り込み時刻）。
      -- アプリ側は行を複数バッチに分けてこの関数を呼ぶため、バッチごとに now() を
      -- 取ると registered_at と deadline_at がバッチ間で数秒ずれる。呼び出し側が
      -- 1つの時刻を渡してきたらそれを使い、渡されなければ従来どおり実行時刻に落とす。
      computed_registered_at := coalesce(target_registered_at, execution_time);
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
