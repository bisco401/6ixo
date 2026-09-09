-- Public contact submissions are sent only by the Edge Function. Quota records
-- contain short-lived keyed hashes, not contact details or message text.
create table if not exists public.contact_message_rate_limits (
    scope text not null,
    bucket_start timestamptz not null,
    request_count integer not null default 0 check (request_count >= 0),
    primary key (scope, bucket_start)
);
create index if not exists contact_message_rate_limits_bucket_idx
    on public.contact_message_rate_limits (bucket_start);
alter table public.contact_message_rate_limits enable row level security;
revoke all on table public.contact_message_rate_limits from public, anon, authenticated;

create or replace function public.consume_contact_message_quota(p_ip_hash text, p_email_hash text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_hour timestamptz := date_trunc('hour', v_now, 'UTC');
    v_day timestamptz := date_trunc('day', v_now, 'UTC');
    v_scope text;
    v_bucket timestamptz;
    v_limit integer;
    v_count integer;
    v_end timestamptz;
    i integer;
begin
    if p_ip_hash is null or p_email_hash is null
       or p_ip_hash !~ '^[0-9a-f]{64}$' or p_email_hash !~ '^[0-9a-f]{64}$' then
        return query select false, 3600;
        return;
    end if;
    -- Serialize the checks and increments across Edge Function instances.
    perform pg_advisory_xact_lock(hashtextextended('contact_message_quota_v1', 0));
    for i in 1..3 loop
        v_scope := case i when 1 then 'ip:' || p_ip_hash when 2 then 'email:' || p_email_hash else 'global' end;
        v_bucket := case when i = 3 then v_day else v_hour end;
        v_limit := case i when 1 then 5 when 2 then 3 else 100 end;
        v_end := v_bucket + case when i = 3 then interval '1 day' else interval '1 hour' end;
        select request_count into v_count from public.contact_message_rate_limits
         where scope = v_scope and bucket_start = v_bucket;
        if coalesce(v_count, 0) >= v_limit then
            return query select false, greatest(1, ceil(extract(epoch from v_end - v_now))::integer);
            return;
        end if;
    end loop;
    for i in 1..3 loop
        v_scope := case i when 1 then 'ip:' || p_ip_hash when 2 then 'email:' || p_email_hash else 'global' end;
        v_bucket := case when i = 3 then v_day else v_hour end;
        insert into public.contact_message_rate_limits (scope, bucket_start, request_count)
        values (v_scope, v_bucket, 1)
        on conflict (scope, bucket_start) do update
          set request_count = public.contact_message_rate_limits.request_count + 1;
    end loop;
    delete from public.contact_message_rate_limits where bucket_start < v_day - interval '2 days';
    return query select true, 0;
end;
$$;
revoke all on function public.consume_contact_message_quota(text, text) from public, anon, authenticated;
grant execute on function public.consume_contact_message_quota(text, text) to service_role;
