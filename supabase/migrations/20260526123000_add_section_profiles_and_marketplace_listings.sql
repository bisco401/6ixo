create extension if not exists pgcrypto;
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
create table if not exists public.marketplace_profiles (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('mp_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    display_name text not null,
    photo_url text,
    bio text,
    city text,
    region text,
    country text,
    map_visible boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
drop trigger if exists marketplace_profiles_set_updated_at on public.marketplace_profiles;
create trigger marketplace_profiles_set_updated_at
before update on public.marketplace_profiles
for each row execute function public.set_updated_at();
alter table public.marketplace_profiles enable row level security;
drop policy if exists "marketplace_profiles_select_all" on public.marketplace_profiles;
create policy "marketplace_profiles_select_all"
on public.marketplace_profiles
for select
using (true);
drop policy if exists "marketplace_profiles_insert_own" on public.marketplace_profiles;
create policy "marketplace_profiles_insert_own"
on public.marketplace_profiles
for insert
to authenticated
with check (auth.uid() = user_id);
drop policy if exists "marketplace_profiles_update_own" on public.marketplace_profiles;
create policy "marketplace_profiles_update_own"
on public.marketplace_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
grant select on public.marketplace_profiles to anon, authenticated;
grant insert, update on public.marketplace_profiles to authenticated;
create table if not exists public.dating_profiles (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('dp_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    alias text,
    display_name text not null,
    bio text,
    age int,
    city text,
    region text,
    country text,
    photo_urls text[] not null default '{}',
    is_discoverable boolean not null default true,
    show_exact_city boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
drop trigger if exists dating_profiles_set_updated_at on public.dating_profiles;
create trigger dating_profiles_set_updated_at
before update on public.dating_profiles
for each row execute function public.set_updated_at();
alter table public.dating_profiles enable row level security;
drop policy if exists "dating_profiles_select_discoverable_or_own" on public.dating_profiles;
create policy "dating_profiles_select_discoverable_or_own"
on public.dating_profiles
for select
using (is_discoverable = true or auth.uid() = user_id);
drop policy if exists "dating_profiles_insert_own" on public.dating_profiles;
create policy "dating_profiles_insert_own"
on public.dating_profiles
for insert
to authenticated
with check (auth.uid() = user_id);
drop policy if exists "dating_profiles_update_own" on public.dating_profiles;
create policy "dating_profiles_update_own"
on public.dating_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
grant select on public.dating_profiles to anon, authenticated;
grant insert, update on public.dating_profiles to authenticated;
create table if not exists public.marketplace_listings (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('ml_' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))),
    user_id uuid not null references auth.users(id) on delete cascade,
    marketplace_profile_id uuid references public.marketplace_profiles(id) on delete set null,
    category text not null,
    subcategory text,
    title text not null,
    description text,
    price numeric,
    currency text not null default 'USD',
    city text,
    region text,
    country text,
    status text not null default 'published' check (status in ('draft', 'published', 'paused', 'sold', 'removed')),
    placement text not null default 'market',
    featured boolean not null default false,
    media_urls text[] not null default '{}',
    primary_media_url text,
    listing_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists marketplace_listings_status_created_idx
    on public.marketplace_listings (status, created_at desc);
create index if not exists marketplace_listings_category_location_idx
    on public.marketplace_listings (category, country, city);
create index if not exists marketplace_listings_user_idx
    on public.marketplace_listings (user_id, created_at desc);
drop trigger if exists marketplace_listings_set_updated_at on public.marketplace_listings;
create trigger marketplace_listings_set_updated_at
before update on public.marketplace_listings
for each row execute function public.set_updated_at();
alter table public.marketplace_listings enable row level security;
drop policy if exists "marketplace_listings_select_published_or_own" on public.marketplace_listings;
create policy "marketplace_listings_select_published_or_own"
on public.marketplace_listings
for select
using (status = 'published' or auth.uid() = user_id);
drop policy if exists "marketplace_listings_insert_own" on public.marketplace_listings;
create policy "marketplace_listings_insert_own"
on public.marketplace_listings
for insert
to authenticated
with check (auth.uid() = user_id);
drop policy if exists "marketplace_listings_update_own" on public.marketplace_listings;
create policy "marketplace_listings_update_own"
on public.marketplace_listings
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
drop policy if exists "marketplace_listings_delete_own" on public.marketplace_listings;
create policy "marketplace_listings_delete_own"
on public.marketplace_listings
for delete
to authenticated
using (auth.uid() = user_id);
grant select on public.marketplace_listings to anon, authenticated;
grant insert, update, delete on public.marketplace_listings to authenticated;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('profile-media', 'profile-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    ('dating-profile-media', 'dating-profile-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    ('marketplace-media', 'marketplace-media', true, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "public_media_select" on storage.objects;
create policy "public_media_select"
on storage.objects
for select
using (bucket_id in ('profile-media', 'dating-profile-media', 'marketplace-media'));
drop policy if exists "profile_media_insert_own" on storage.objects;
create policy "profile_media_insert_own"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "dating_profile_media_insert_own" on storage.objects;
create policy "dating_profile_media_insert_own"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'dating-profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "marketplace_media_insert_own" on storage.objects;
create policy "marketplace_media_insert_own"
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'marketplace-media'
    and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "profile_media_update_own" on storage.objects;
create policy "profile_media_update_own"
on storage.objects
for update
to authenticated
using (
    bucket_id in ('profile-media', 'dating-profile-media', 'marketplace-media')
    and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
    bucket_id in ('profile-media', 'dating-profile-media', 'marketplace-media')
    and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "profile_media_delete_own" on storage.objects;
create policy "profile_media_delete_own"
on storage.objects
for delete
to authenticated
using (
    bucket_id in ('profile-media', 'dating-profile-media', 'marketplace-media')
    and (storage.foldername(name))[1] = auth.uid()::text
);
