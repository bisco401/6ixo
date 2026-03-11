insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'host-documents',
    'host-documents',
    false,
    15728640,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.host_application_documents (
    id uuid primary key default gen_random_uuid(),
    application_id uuid not null references public.host_applications(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    document_type text not null,
    file_name text not null,
    storage_path text not null unique,
    mime_type text,
    size_bytes bigint,
    created_at timestamptz not null default timezone('utc', now())
);

create index if not exists host_application_documents_application_idx
    on public.host_application_documents (application_id, created_at desc);

create index if not exists host_application_documents_user_idx
    on public.host_application_documents (user_id, created_at desc);

alter table public.host_application_documents enable row level security;

drop policy if exists "host_application_documents_select_own_or_admin" on public.host_application_documents;
create policy "host_application_documents_select_own_or_admin"
    on public.host_application_documents
    for select
    to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "host_application_documents_insert_own" on public.host_application_documents;
create policy "host_application_documents_insert_own"
    on public.host_application_documents
    for insert
    to authenticated
    with check (auth.uid() = user_id);

drop policy if exists "host_application_documents_delete_own_or_admin" on public.host_application_documents;
create policy "host_application_documents_delete_own_or_admin"
    on public.host_application_documents
    for delete
    to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "host_documents_select_own_or_admin" on storage.objects;
create policy "host_documents_select_own_or_admin"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'host-documents'
        and (
            auth.uid()::text = (storage.foldername(name))[1]
            or public.is_admin_user()
        )
    );

drop policy if exists "host_documents_insert_own" on storage.objects;
create policy "host_documents_insert_own"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'host-documents'
        and auth.uid()::text = (storage.foldername(name))[1]
    );

drop policy if exists "host_documents_delete_own_or_admin" on storage.objects;
create policy "host_documents_delete_own_or_admin"
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'host-documents'
        and (
            auth.uid()::text = (storage.foldername(name))[1]
            or public.is_admin_user()
        )
    );

create table if not exists public.short_term_listings (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('st_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 20)),
    user_id uuid not null references auth.users(id) on delete cascade,
    host_application_id uuid references public.host_applications(id) on delete set null,
    title text not null,
    description text not null,
    city text not null,
    country text not null,
    price numeric(12, 2) not null,
    currency text not null default 'USD',
    status text not null default 'published',
    listing_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'short_term_listings_status_check'
    ) then
        alter table public.short_term_listings
            add constraint short_term_listings_status_check
            check (status in ('draft', 'published', 'archived'));
    end if;
end $$;

create index if not exists short_term_listings_public_idx
    on public.short_term_listings (status, created_at desc);

create index if not exists short_term_listings_user_idx
    on public.short_term_listings (user_id, created_at desc);

create or replace function public.short_term_listings_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists short_term_listings_set_updated_at on public.short_term_listings;
create trigger short_term_listings_set_updated_at
before update on public.short_term_listings
for each row
execute function public.short_term_listings_set_updated_at();

alter table public.short_term_listings enable row level security;

drop policy if exists "short_term_listings_public_select" on public.short_term_listings;
create policy "short_term_listings_public_select"
    on public.short_term_listings
    for select
    to anon, authenticated
    using (status = 'published');

drop policy if exists "short_term_listings_owner_select" on public.short_term_listings;
create policy "short_term_listings_owner_select"
    on public.short_term_listings
    for select
    to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "short_term_listings_admin_update" on public.short_term_listings;
create policy "short_term_listings_admin_update"
    on public.short_term_listings
    for update
    to authenticated
    using (public.is_admin_user())
    with check (public.is_admin_user());

create or replace function public.create_short_term_listing(listing_payload jsonb)
returns public.short_term_listings
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    approved_application_id uuid;
    profile_row public.profiles%rowtype;
    payload jsonb := coalesce(listing_payload, '{}'::jsonb);
    payload_realestate jsonb := coalesce(payload -> 'realestate', '{}'::jsonb);
    listing_title text := trim(coalesce(payload ->> 'title', ''));
    listing_description text := trim(coalesce(payload ->> 'description', ''));
    listing_city text := trim(coalesce(payload ->> 'city', ''));
    listing_country text := trim(coalesce(payload ->> 'country', ''));
    listing_price numeric(12, 2);
    listing_currency text := upper(trim(coalesce(payload ->> 'currency', 'USD')));
    listing_type text := lower(trim(coalesce(payload_realestate ->> 'listingType', payload ->> 'listingType', '')));
    listing_status text := lower(trim(coalesce(payload ->> 'status', 'published')));
    result_row public.short_term_listings;
begin
    if caller_id is null then
        raise exception 'Authentication required.' using errcode = '42501';
    end if;

    select *
    into profile_row
    from public.profiles
    where id = caller_id;

    if not found then
        raise exception 'Profile not found.' using errcode = '42501';
    end if;

    if coalesce(profile_row.host_status, 'none') <> 'approved' then
        raise exception 'Host approval required before posting short-term rentals.' using errcode = '42501';
    end if;

    if coalesce(profile_row.host_email_verified, false) = false then
        raise exception 'Verified email required before posting short-term rentals.' using errcode = '42501';
    end if;

    select id
    into approved_application_id
    from public.host_applications
    where user_id = caller_id
      and status = 'approved'
    order by reviewed_at desc nulls last, submitted_at desc
    limit 1;

    if approved_application_id is null then
        raise exception 'Approved host application not found.' using errcode = '42501';
    end if;

    if listing_title = '' then
        raise exception 'Listing title is required.' using errcode = '22023';
    end if;

    if listing_description = '' then
        raise exception 'Listing description is required.' using errcode = '22023';
    end if;

    if listing_city = '' or listing_country = '' then
        raise exception 'Listing city and country are required.' using errcode = '22023';
    end if;

    if listing_type <> 'for_rent_short' then
        raise exception 'Only short-term rental listings are allowed in this RPC.' using errcode = '22023';
    end if;

    listing_price := nullif(trim(coalesce(payload ->> 'price', '')), '')::numeric;
    if listing_price is null or listing_price < 0 then
        raise exception 'Listing price must be zero or greater.' using errcode = '22023';
    end if;

    if listing_status not in ('draft', 'published', 'archived') then
        listing_status := 'published';
    end if;

    insert into public.short_term_listings (
        user_id,
        host_application_id,
        title,
        description,
        city,
        country,
        price,
        currency,
        status,
        listing_payload
    )
    values (
        caller_id,
        approved_application_id,
        listing_title,
        listing_description,
        listing_city,
        listing_country,
        listing_price,
        case when listing_currency = '' then 'USD' else listing_currency end,
        listing_status,
        payload
    )
    returning * into result_row;

    return result_row;
end;
$$;

grant execute on function public.create_short_term_listing(jsonb) to authenticated;
