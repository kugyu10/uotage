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
-- カウントは拒否時も加算される（insert 後に判定するため）。窓が替われば白紙に戻る、
-- という固定窓の一般的な性質。拒否時も同一キーの1行へ書き込みが走り行ロックで
-- 直列化するが、想定規模（認証済みオペレーター少人数の連打・リトライループ）では
-- DB 保護よりアプリワーカー保護が目的なので許容する。問題になったら
-- 「request_count が上限未満のときだけ update する」形に変える。
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
-- on conflict (limit_key, window_start) の推論句は列名を式として解析するため、
-- 引数 limit_key と rate_limit_counters.limit_key 列の両方に解決できて
-- 42702 (ambiguous) になる。推論句には関数名修飾が使えないので、
-- register_reader の同種障害 (20260902020000) と同じく use_column で解決する。
-- 本文中の引数参照は consume_rate_limit.limit_key と明示修飾済みなので影響しない。
#variable_conflict use_column
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

  -- 過去の窓は今後読まれないため、同じキーが再利用されるたびに、そのキーの古い窓を
  -- 掃除する（cron を増やさない）。二度と使われないキーの最終窓1行だけは残るが、
  -- 上限はオペレーター数程度なので許容する。
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
