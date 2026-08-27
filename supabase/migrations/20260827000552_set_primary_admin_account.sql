do $$
declare
    target_user_id uuid;
    target_metadata jsonb;
begin
    select id, coalesce(raw_user_meta_data, '{}'::jsonb)
    into target_user_id, target_metadata
    from auth.users
    where lower(email) = lower('6ix06ix6ix@gmail.com')
    order by created_at asc
    limit 1;

    if target_user_id is null then
        raise exception 'The admin account 6ix06ix6ix@gmail.com must register before admin access can be granted.';
    end if;

    insert into public.profiles (
        id,
        first_name,
        last_name,
        full_name,
        is_admin,
        updated_at
    )
    values (
        target_user_id,
        nullif(trim(target_metadata ->> 'first_name'), ''),
        nullif(trim(target_metadata ->> 'last_name'), ''),
        nullif(trim(target_metadata ->> 'full_name'), ''),
        true,
        now()
    )
    on conflict (id) do update
    set is_admin = true,
        updated_at = now();
end
$$;

create or replace function public.protect_profile_admin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    is_privileged_service boolean := current_user in ('postgres', 'supabase_admin', 'service_role')
        or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
    if tg_op = 'INSERT' then
        if new.is_admin = false then
            return new;
        end if;
    elsif new.is_admin is not distinct from old.is_admin then
        return new;
    end if;

    if is_privileged_service or public.is_admin_user() then
        return new;
    end if;

    raise exception 'Admin role changes require administrator access.'
        using errcode = '42501';
end
$$;

drop trigger if exists protect_profile_admin_flag_trigger on public.profiles;
create trigger protect_profile_admin_flag_trigger
before insert or update of is_admin on public.profiles
for each row
execute function public.protect_profile_admin_flag();

revoke all on function public.protect_profile_admin_flag() from public;
