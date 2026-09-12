-- Configuration is stored separately from migration source; no credentials in Git.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create table public.rental_runtime_config(id boolean primary key default true check(id),supabase_url text not null);
revoke all on public.rental_runtime_config from public,anon,authenticated;
grant all on public.rental_runtime_config to service_role;
alter table public.rental_runtime_config enable row level security;

create or replace function public.run_rental_maintenance()
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare token text; endpoint text; request_id bigint;
begin
 select decrypted_secret into token from vault.decrypted_secrets where name='rental_worker_token' limit 1;
 select supabase_url||'/functions/v1/rental-maintenance' into endpoint from public.rental_runtime_config where id;
 if token is null or endpoint is null then return null; end if;
 select net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),body:='{}'::jsonb,timeout_milliseconds:=120000) into request_id;
 return request_id;
end $$;
revoke all on function public.run_rental_maintenance() from public,anon,authenticated;
select cron.schedule('6ixo-rental-maintenance','* * * * *','select public.run_rental_maintenance();');
