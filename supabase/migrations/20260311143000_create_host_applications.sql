alter table if exists public.profiles
    add column if not exists host_status text not null default 'none',
    add column if not exists host_email_verified boolean not null default false,
    add column if not exists host_approved_at timestamptz,
    add column if not exists host_rejected_at timestamptz,
    add column if not exists host_review_notes text,
    add column if not exists is_admin boolean not null default false;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'profiles_host_status_check'
    ) then
        alter table public.profiles
            add constraint profiles_host_status_check
            check (host_status in ('none', 'pending', 'approved', 'rejected', 'needs_more_info'));
    end if;
end $$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and is_admin = true
    );
$$;

grant execute on function public.is_admin_user() to anon, authenticated;

create table if not exists public.host_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    email text not null,
    legal_name text not null,
    phone text not null,
    city text not null,
    country text not null,
    property_type text not null,
    listing_city text not null,
    hosting_experience text not null,
    about_host text not null,
    rules_acknowledged boolean not null default false,
    status text not null default 'pending',
    submitted_at timestamptz not null default timezone('utc', now()),
    reviewed_at timestamptz,
    reviewed_by uuid references auth.users(id) on delete set null,
    review_notes text,
    unique (user_id)
);

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'host_applications_status_check'
    ) then
        alter table public.host_applications
            add constraint host_applications_status_check
            check (status in ('pending', 'approved', 'rejected', 'needs_more_info'));
    end if;
end $$;

create index if not exists host_applications_user_idx
    on public.host_applications (user_id);

create index if not exists host_applications_status_idx
    on public.host_applications (status, submitted_at desc);

alter table public.host_applications enable row level security;

drop policy if exists "host_applications_select_own_or_admin" on public.host_applications;
create policy "host_applications_select_own_or_admin"
    on public.host_applications
    for select
    to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "host_applications_insert_own" on public.host_applications;
create policy "host_applications_insert_own"
    on public.host_applications
    for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and status = 'pending'
    );

drop policy if exists "host_applications_update_own_pending" on public.host_applications;
create policy "host_applications_update_own_pending"
    on public.host_applications
    for update
    to authenticated
    using (
        auth.uid() = user_id
        and status in ('pending', 'rejected', 'needs_more_info')
    )
    with check (
        auth.uid() = user_id
        and status = 'pending'
    );

drop policy if exists "host_applications_update_admin" on public.host_applications;
create policy "host_applications_update_admin"
    on public.host_applications
    for update
    to authenticated
    using (public.is_admin_user())
    with check (public.is_admin_user());

drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update"
    on public.profiles
    for update
    to authenticated
    using (public.is_admin_user())
    with check (public.is_admin_user());
