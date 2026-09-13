-- issue #3: オペレーター向けアップロード経路（CSVインポートのドライラン・確定実行）に
-- レートリミットがない。bodySizeLimit を 8MB に引き上げたため、認証済みオペレーター
-- 1人が短時間に大量の 8MB リクエストを投げる（悪意よりリトライループや連打などの事故を
-- 想定）とワーカーを圧迫しうる。
--
-- 固定窓（fixed window）のカウンタを DB に置く。Vercel のようなサーバーレス環境では
-- プロセス内メモリのカウンタがインスタンスごとに分かれて実効性がないため、
-- 全インスタンスで共有される DB を正とする。
--
-- consume_rate_limit は「1回消費を試みて、許可されたかどうか」を返す。
--   - true  = 窓内の消費数が max_requests 以下（実行してよい）
--   - false = 上限超過（呼び出し側は 429 相当のエラーメッセージを返す）
-- カウントは拒否時も進めない（insert 後の判定なので、窓内で max_requests を超えた分は
-- 数字としては増えるが、次の窓では白紙に戻る。固定窓の一般的な性質）。
--
-- register_reader / import_scenario_readers と同じく SECURITY DEFINER + service_role 限定。
-- テーブルには RLS を有効にしたままポリシーを作らない（この RPC 以外から触らせない）。

create table public.rate_limit_counters (
  limit_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (limit_key, window_start)
);

alter table public.rate_limit_counters enable row level security;

create function public.consume_rate_limit(
  limit_key text,
  max_requests integer,
  window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_window timestamptz;
  current_count integer;
begin
  if consume_rate_limit.limit_key is null or length(trim(consume_rate_limit.limit_key)) = 0 then
    raise exception 'limit_key is required';
  end if;
  if max_requests is null or max_requests < 1 then
    raise exception 'max_requests must be >= 1';
  end if;
  if window_seconds is null or window_seconds < 1 then
    raise exception 'window_seconds must be >= 1';
  end if;

  -- epoch を window_seconds で切り捨てた固定窓。now() ベースなのでアプリ側の時計に依存しない。
  current_window := to_timestamp(floor(extract(epoch from now()) / window_seconds) * window_seconds);

  -- 過去の窓は今後読まれないため、同じキーを消費するついでに掃除する
  -- （cron を増やさずにテーブルの際限ない成長を防ぐ）。
  delete from public.rate_limit_counters as counters
  where counters.limit_key = consume_rate_limit.limit_key
    and counters.window_start < current_window;

  insert into public.rate_limit_counters as counters (limit_key, window_start, request_count)
  values (consume_rate_limit.limit_key, current_window, 1)
  on conflict (limit_key, window_start)
  do update set request_count = counters.request_count + 1
  returning counters.request_count into current_count;

  return current_count <= max_requests;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
