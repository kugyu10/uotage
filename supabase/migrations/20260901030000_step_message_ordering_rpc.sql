-- コードレビュー指摘 [中] 2件。ステップの position 操作を SQL 側に閉じ込める。
--
-- 1) createStep が「max(position) を読む → insert する」の2往復だったため、
--    同時追加で position が衝突しうる。
-- 2) moveStep が position の入れ替えを UPDATE 2本に分けていたため、
--    間で失敗すると position が重複したまま残る。
--
-- どちらも security invoker で定義し、RLS(step_messages_tenant_access /
-- scenarios_tenant_access)をそのまま呼び出し元の権限で効かせる。
-- テナント越えの操作は既存ポリシーが弾くため、関数内での再チェックは不要。
-- 同一シナリオに対する操作は scenarios の行ロックで直列化する。

/** ステップを末尾に追加し、新しい id を返す。position の採番を1トランザクションに閉じる。 */
create function public.append_step_message(target_scenario_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  locked_tenant_id uuid;
  new_step_id uuid;
begin
  -- 同一シナリオへの追加を直列化する(RLS により他テナントの行は見えない)。
  select scenario.tenant_id into locked_tenant_id from public.scenarios scenario
    where scenario.id = target_scenario_id for update;
  if not found then raise exception 'scenario not found'; end if;

  insert into public.step_messages
    (tenant_id, scenario_id, position, delay_minutes, send_at_hour, subject, body, skip_if_purchased)
  select locked_tenant_id, target_scenario_id,
    coalesce(max(step.position) + 1, 0),
    0, null, '', '', true
  from public.step_messages step
  where step.scenario_id = target_scenario_id
  returning id into new_step_id;

  return new_step_id;
end;
$$;

/**
 * ステップを隣接するステップと入れ替える。
 * 隣の特定と入れ替えを1トランザクションで行い、UPDATE も1文にまとめる。
 * 並び順は他の参照箇所(register_reader 等)と同じ (position, id) を使う。
 */
create function public.move_step_message(
  target_scenario_id uuid,
  target_step_id uuid,
  move_direction text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_position integer;
  neighbor_id uuid;
  neighbor_position integer;
begin
  if move_direction not in ('up', 'down') then
    raise exception 'invalid move_direction: %', move_direction;
  end if;

  perform 1 from public.scenarios scenario
    where scenario.id = target_scenario_id for update;
  if not found then raise exception 'scenario not found'; end if;

  select step.position into current_position from public.step_messages step
    where step.scenario_id = target_scenario_id and step.id = target_step_id;
  if not found then raise exception 'step not found'; end if;

  if move_direction = 'up' then
    select step.id, step.position into neighbor_id, neighbor_position
      from public.step_messages step
      where step.scenario_id = target_scenario_id
        and (step.position, step.id) < (current_position, target_step_id)
      order by step.position desc, step.id desc limit 1;
  else
    select step.id, step.position into neighbor_id, neighbor_position
      from public.step_messages step
      where step.scenario_id = target_scenario_id
        and (step.position, step.id) > (current_position, target_step_id)
      order by step.position asc, step.id asc limit 1;
  end if;
  -- 端のステップは移動できない。呼び出し側のエラーにはしない。
  if not found then return; end if;

  update public.step_messages step set
    position = case when step.id = target_step_id then neighbor_position else current_position end
    where step.scenario_id = target_scenario_id
      and step.id in (target_step_id, neighbor_id);
end;
$$;

revoke all on function public.append_step_message(uuid) from public;
grant execute on function public.append_step_message(uuid) to authenticated;
revoke all on function public.move_step_message(uuid, uuid, text) from public;
grant execute on function public.move_step_message(uuid, uuid, text) to authenticated;
