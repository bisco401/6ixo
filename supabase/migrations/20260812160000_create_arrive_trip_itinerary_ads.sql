-- Accepted Arrive+ locals can attach one of their ads to a traveler's itinerary.
create extension if not exists pgcrypto;

create table if not exists public.arrive_trip_itinerary_ads (
    id uuid primary key default gen_random_uuid(),
    trip_id uuid not null references public.arrive_trips(id) on delete cascade,
    alert_id uuid not null references public.arrive_trip_alerts(id) on delete cascade,
    local_user_id uuid not null references auth.users(id) on delete cascade,
    marketplace_item_id text not null,
    listing_snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint arrive_trip_itinerary_ads_listing_snapshot_object
        check (jsonb_typeof(listing_snapshot) = 'object'),
    constraint arrive_trip_itinerary_ads_alert_listing_unique
        unique (alert_id, marketplace_item_id)
);

create index if not exists arrive_trip_itinerary_ads_trip_created_idx
    on public.arrive_trip_itinerary_ads (trip_id, created_at desc);

create index if not exists arrive_trip_itinerary_ads_local_created_idx
    on public.arrive_trip_itinerary_ads (local_user_id, created_at desc);

alter table public.arrive_trip_itinerary_ads enable row level security;

drop policy if exists "Arrive itinerary ads are visible to participants" on public.arrive_trip_itinerary_ads;
create policy "Arrive itinerary ads are visible to participants"
on public.arrive_trip_itinerary_ads
for select
to authenticated
using (
    local_user_id = auth.uid()
    or exists (
        select 1
        from public.arrive_trips trip
        where trip.id = arrive_trip_itinerary_ads.trip_id
          and trip.user_id = auth.uid()
    )
);

drop policy if exists "Accepted locals can add itinerary ads" on public.arrive_trip_itinerary_ads;
create policy "Accepted locals can add itinerary ads"
on public.arrive_trip_itinerary_ads
for insert
to authenticated
with check (
    local_user_id = auth.uid()
    and exists (
        select 1
        from public.arrive_trip_alerts alert
        where alert.id = arrive_trip_itinerary_ads.alert_id
          and alert.trip_id = arrive_trip_itinerary_ads.trip_id
          and alert.local_user_id = auth.uid()
          and alert.status::text in ('inquired', 'accepted')
    )
);

drop policy if exists "Locals can update their itinerary ads" on public.arrive_trip_itinerary_ads;
create policy "Locals can update their itinerary ads"
on public.arrive_trip_itinerary_ads
for update
to authenticated
using (local_user_id = auth.uid())
with check (
    local_user_id = auth.uid()
    and exists (
        select 1
        from public.arrive_trip_alerts alert
        where alert.id = arrive_trip_itinerary_ads.alert_id
          and alert.trip_id = arrive_trip_itinerary_ads.trip_id
          and alert.local_user_id = auth.uid()
          and alert.status::text in ('inquired', 'accepted')
    )
);

drop policy if exists "Locals can remove their itinerary ads" on public.arrive_trip_itinerary_ads;
create policy "Locals can remove their itinerary ads"
on public.arrive_trip_itinerary_ads
for delete
to authenticated
using (local_user_id = auth.uid());

grant select, insert, update, delete on public.arrive_trip_itinerary_ads to authenticated;
