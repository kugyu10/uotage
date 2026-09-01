-- 復旧用SQL（1回だけ実行する。Supabase Dashboard の SQL Editor で実行してください）
--
-- 経緯:
--   2026-09-02 の検証作業中、claim_deliveries の検証スクリプトの後片付けに
--   書いた catch-all の DELETE
--     deliveries?scenario_reader_id=not.is.null&tenant_id=eq.<TENANT>&step_message_id=not.is.null
--   が、テスト行だけでなくテナント内の全 deliveries に一致してしまい、
--   2026-08-15/16 のテスト送信履歴2件（status='sent'）を削除した。
--   readers / scenario_readers / purchases / products など他のテーブルは無傷。
--
-- 復元できる情報（削除前に取得したスナップショットより）:
--   id / scheduled_at / sent_at / status / step_message_id
--   reader_id と scenario_reader_id は、scheduled_at が scenario_readers.registered_at と
--   一致するため一意に決まる（01:27:47 と 02:06:37 で重複なし）。
--
-- 復元できない情報:
--   resend_message_id … Resend が採番したメッセージID。スナップショットに含めていなかった。
--   attempt_count     … 同上。列の既定値(0)のまま入る。実際は1だったと思われるが、
--                       推測値を書くより空のままにして、下の error_message で
--                       再構成された行であることを明示する。
--
-- 安全性: status='sent' で入るため、配信ワーカー（status='queued' のみ claim する）は
--   この行に触れない。再送は発生しない。

insert into public.deliveries (
  id, tenant_id, scenario_reader_id, step_message_id, reader_id,
  scheduled_at, status, sent_at, error_message
)
select
  snapshot.id,
  enrollment.tenant_id,
  enrollment.id,
  'ca61b8a9-7d5f-462e-a19c-2f0b2e90070a'::uuid,  -- 決済疎通テストシナリオの1通目
  enrollment.reader_id,
  snapshot.scheduled_at,
  'sent',
  snapshot.sent_at,
  '[復旧] 2026-09-02の検証作業で誤削除した行を再作成。resend_message_id と attempt_count は復元不能。'
from (values
  ('b71f9a23-c75a-4377-8279-8083abaf80d6'::uuid,
   '2026-08-15T01:27:47+00:00'::timestamptz,
   '2026-08-15T14:53:40.638+00:00'::timestamptz),
  ('c612db92-2d06-43a2-836c-16b566bdab0c'::uuid,
   '2026-08-15T02:06:37+00:00'::timestamptz,
   '2026-08-16T15:15:39.024+00:00'::timestamptz)
) as snapshot (id, scheduled_at, sent_at)
join public.scenario_readers enrollment
  on enrollment.registered_at = snapshot.scheduled_at
on conflict (id) do nothing;

-- 確認用: 2件が status='sent' で戻っていること。
select id, status, scheduled_at, sent_at, reader_id
from public.deliveries
order by scheduled_at;
