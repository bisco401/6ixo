create table if not exists public.google_places_rate_limits (
    scope text not null,
    bucket_start timestamptz not null,
    request_count integer not null default 0 check (request_count >= 0),
    updated_at timestamptz not null default now(),
    primary key (scope, bucket_start)
);

create index if not exists google_places_rate_limits_bucket_start_idx
    on public.google_places_rate_limits (bucket_start);

alter table public.google_places_rate_limits enable row level security;

revoke all on table public.google_places_rate_limits from public, anon, authenticated;

create or replace function public.consume_google_places_quota(
    p_user_id uuid,
    p_minute_limit integer default 5,
    p_day_limit integer default 25,
    p_global_day_limit integer default 150
)
returns table (
    allowed boolean,
    retry_after_seconds integer,
    limit_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_minute_start timestamptz := date_trunc('minute', v_now, 'UTC');
    v_day_start timestamptz := date_trunc('day', v_now, 'UTC');
    v_user_minute_scope text := 'user:' || p_user_id::text || ':minute';
    v_user_day_scope text := 'user:' || p_user_id::text || ':day';
    v_global_day_scope text := 'global:day';
    v_minute_count integer := 0;
    v_user_day_count integer := 0;
    v_global_day_count integer := 0;
begin
    if p_user_id is null
       or p_minute_limit < 1
       or p_day_limit < 1
       or p_global_day_limit < 1 then
        return query select false, 60, 'invalid'::text;
        return;
    end if;

    -- The global lock makes the three counter checks and increments one atomic action.
    perform pg_advisory_xact_lock(hashtextextended('google_places_quota_v1', 0));

    select coalesce(request_count, 0)
      into v_minute_count
      from public.google_places_rate_limits
     where scope = v_user_minute_scope
       and bucket_start = v_minute_start;
    v_minute_count := coalesce(v_minute_count, 0);

    select coalesce(request_count, 0)
      into v_user_day_count
      from public.google_places_rate_limits
     where scope = v_user_day_scope
       and bucket_start = v_day_start;
    v_user_day_count := coalesce(v_user_day_count, 0);

    select coalesce(request_count, 0)
      into v_global_day_count
      from public.google_places_rate_limits
     where scope = v_global_day_scope
       and bucket_start = v_day_start;
    v_global_day_count := coalesce(v_global_day_count, 0);

    if v_minute_count >= p_minute_limit then
        return query
        select false,
               greatest(1, ceil(extract(epoch from (v_minute_start + interval '1 minute' - v_now)))::integer),
               'user_minute'::text;
        return;
    end if;

    if v_user_day_count >= p_day_limit then
        return query
        select false,
               greatest(1, ceil(extract(epoch from (v_day_start + interval '1 day' - v_now)))::integer),
               'user_day'::text;
        return;
    end if;

    if v_global_day_count >= p_global_day_limit then
        return query
        select false,
               greatest(1, ceil(extract(epoch from (v_day_start + interval '1 day' - v_now)))::integer),
               'global_day'::text;
        return;
    end if;

    insert into public.google_places_rate_limits (scope, bucket_start, request_count, updated_at)
    values (v_user_minute_scope, v_minute_start, 1, v_now)
    on conflict (scope, bucket_start) do update
        set request_count = public.google_places_rate_limits.request_count + 1,
            updated_at = excluded.updated_at;

    insert into public.google_places_rate_limits (scope, bucket_start, request_count, updated_at)
    values (v_user_day_scope, v_day_start, 1, v_now)
    on conflict (scope, bucket_start) do update
        set request_count = public.google_places_rate_limits.request_count + 1,
            updated_at = excluded.updated_at;

    insert into public.google_places_rate_limits (scope, bucket_start, request_count, updated_at)
    values (v_global_day_scope, v_day_start, 1, v_now)
    on conflict (scope, bucket_start) do update
        set request_count = public.google_places_rate_limits.request_count + 1,
            updated_at = excluded.updated_at;

    delete from public.google_places_rate_limits
     where bucket_start < v_day_start - interval '2 days';

    return query select true, 0, 'ok'::text;
end;
$$;

revoke all on function public.consume_google_places_quota(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_google_places_quota(uuid, integer, integer, integer) to service_role;

comment on function public.consume_google_places_quota(uuid, integer, integer, integer) is
    'Atomically enforces per-user and project-wide Google Places request limits for the Edge Function.';
