create table if not exists public.vehicle_rental_bookings (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('vrb_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 20)),
    listing_public_id text not null,
    listing_title text not null,
    listing_payload jsonb not null default '{}'::jsonb,
    host_user_id uuid references auth.users(id) on delete set null,
    host_name text,
    guest_user_id uuid references auth.users(id) on delete set null,
    guest_name text not null,
    guest_email text not null,
    pickup_date date not null,
    return_date date not null,
    trip_days integer not null,
    daily_rate numeric(12, 2) not null default 0,
    service_fee numeric(12, 2) not null default 0,
    total numeric(12, 2) not null default 0,
    currency text not null default 'USD',
    status text not null default 'confirmed',
    payment_status text not null default 'unpaid',
    stripe_payment_intent_id text,
    stripe_payment_amount_cents bigint,
    stripe_payment_currency text,
    stripe_payment_authorized_at timestamptz,
    stripe_payment_captured_at timestamptz,
    stripe_payment_cancelled_at timestamptz,
    stripe_payment_refunded_at timestamptz,
    booking_payload jsonb not null default '{}'::jsonb,
    payment_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint vehicle_rental_bookings_date_check check (return_date > pickup_date),
    constraint vehicle_rental_bookings_days_check check (trip_days > 0),
    constraint vehicle_rental_bookings_status_check check (status in ('requested', 'confirmed', 'cancelled', 'declined')),
    constraint vehicle_rental_bookings_payment_status_check check (payment_status in (
        'unpaid',
        'requires_payment_method',
        'authorized',
        'processing',
        'paid',
        'failed',
        'cancelled',
        'refunded'
    ))
);

create index if not exists vehicle_rental_bookings_listing_dates_idx
    on public.vehicle_rental_bookings (listing_public_id, pickup_date, return_date)
    where status in ('requested', 'confirmed');

create index if not exists vehicle_rental_bookings_guest_idx
    on public.vehicle_rental_bookings (guest_user_id, created_at desc);

create index if not exists vehicle_rental_bookings_host_idx
    on public.vehicle_rental_bookings (host_user_id, created_at desc)
    where host_user_id is not null;

create index if not exists vehicle_rental_bookings_payment_intent_idx
    on public.vehicle_rental_bookings (stripe_payment_intent_id)
    where stripe_payment_intent_id is not null;

create or replace function public.vehicle_rental_bookings_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists vehicle_rental_bookings_set_updated_at on public.vehicle_rental_bookings;
create trigger vehicle_rental_bookings_set_updated_at
before update on public.vehicle_rental_bookings
for each row
execute function public.vehicle_rental_bookings_set_updated_at();

alter table public.vehicle_rental_bookings enable row level security;

drop policy if exists "vehicle_rental_bookings_participant_select" on public.vehicle_rental_bookings;
create policy "vehicle_rental_bookings_participant_select"
    on public.vehicle_rental_bookings
    for select
    to authenticated
    using (
        auth.uid() = guest_user_id
        or auth.uid() = host_user_id
        or public.is_admin_user()
    );

drop policy if exists "vehicle_rental_bookings_participant_update" on public.vehicle_rental_bookings;
create policy "vehicle_rental_bookings_participant_update"
    on public.vehicle_rental_bookings
    for update
    to authenticated
    using (auth.uid() = host_user_id or public.is_admin_user())
    with check (auth.uid() = host_user_id or public.is_admin_user());

grant select, update on public.vehicle_rental_bookings to authenticated;

create or replace function public.get_vehicle_rental_blocked_date_entries(p_listing_payload jsonb)
returns table (
    start_date date,
    end_date date
)
language sql
immutable
as $$
    with blocked_source as (
        select case
            when jsonb_typeof(coalesce(p_listing_payload -> 'blockedDates', '[]'::jsonb)) = 'array'
                then coalesce(p_listing_payload -> 'blockedDates', '[]'::jsonb)
            else '[]'::jsonb
        end as entries
    ),
    raw_entries as (
        select value as entry
        from blocked_source,
             jsonb_array_elements(blocked_source.entries)
    ),
    parsed as (
        select
            trim(coalesce(entry ->> 'start', entry ->> 'startDate', entry ->> 'date', '')) as raw_start,
            trim(coalesce(entry ->> 'end', entry ->> 'endDate', entry ->> 'date', entry ->> 'start', entry ->> 'startDate', '')) as raw_end
        from raw_entries
    )
    select
        least(raw_start::date, raw_end::date) as start_date,
        greatest(raw_start::date, raw_end::date) as end_date
    from parsed
    where raw_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and raw_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
$$;

create or replace function public.create_vehicle_rental_booking(
    p_listing_public_id text,
    booking_payload jsonb
)
returns public.vehicle_rental_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    payload jsonb := coalesce(booking_payload, '{}'::jsonb);
    listing_ref text := trim(coalesce(p_listing_public_id, payload ->> 'listingId', payload ->> 'listingPublicId', ''));
    listing_snapshot jsonb := coalesce(payload -> 'listingPayload', '{}'::jsonb);
    booking_pickup date;
    booking_return date;
    booking_days integer;
    booking_daily_rate numeric(12, 2) := 0;
    computed_service_fee numeric(12, 2) := 0;
    computed_total numeric(12, 2) := 0;
    booking_guest_name text := trim(coalesce(payload ->> 'guestName', ''));
    booking_guest_email text := lower(trim(coalesce(payload ->> 'guestEmail', '')));
    booking_host_name text := trim(coalesce(payload ->> 'hostName', listing_snapshot ->> 'seller', listing_snapshot ->> 'hostName', ''));
    booking_title text := trim(coalesce(payload ->> 'listingTitle', listing_snapshot ->> 'title', 'Vehicle rental'));
    booking_currency text := upper(trim(coalesce(payload ->> 'currency', listing_snapshot ->> 'currency', 'USD')));
    min_trip_days integer := 1;
    host_ref text := trim(coalesce(payload ->> 'hostUserId', listing_snapshot ->> 'hostUserId', listing_snapshot ->> 'userId', ''));
    parsed_host_id uuid;
    result_row public.vehicle_rental_bookings;
begin
    if caller_id is null then
        raise exception 'Log in to book this rental.' using errcode = '28000';
    end if;

    if listing_ref = '' then
        raise exception 'Vehicle listing is required.' using errcode = '22023';
    end if;

    booking_pickup := nullif(trim(coalesce(payload ->> 'pickupDate', payload ->> 'startDate', '')), '')::date;
    booking_return := nullif(trim(coalesce(payload ->> 'returnDate', payload ->> 'endDate', '')), '')::date;

    if booking_pickup is null or booking_return is null or booking_return <= booking_pickup then
        raise exception 'Return date must be after the pick-up date.' using errcode = '22023';
    end if;

    booking_days := booking_return - booking_pickup;

    if trim(coalesce(payload ->> 'minimumTripDays', listing_snapshot ->> 'minimumTripDays', '')) ~ '^[0-9]+$' then
        min_trip_days := greatest(1, trim(coalesce(payload ->> 'minimumTripDays', listing_snapshot ->> 'minimumTripDays'))::integer);
    end if;

    if booking_days < min_trip_days then
        raise exception 'This rental requires at least % days.', min_trip_days using errcode = '22023';
    end if;

    if exists (
        select 1
        from public.get_vehicle_rental_blocked_date_entries(listing_snapshot) blocked
        where booking_pickup < (blocked.end_date + 1)
          and booking_return > blocked.start_date
    ) then
        raise exception 'Those dates are unavailable. Pick different rental dates.' using errcode = '23505';
    end if;

    lock table public.vehicle_rental_bookings in share row exclusive mode;

    if exists (
        select 1
        from public.vehicle_rental_bookings existing
        where existing.listing_public_id = listing_ref
          and existing.status in ('requested', 'confirmed')
          and booking_pickup < existing.return_date
          and booking_return > existing.pickup_date
    ) then
        raise exception 'Those dates are already booked or requested.' using errcode = '23505';
    end if;

    if trim(coalesce(payload ->> 'dailyRate', listing_snapshot ->> 'dailyRate', listing_snapshot ->> 'priceValue', '')) ~ '^[0-9]+(\.[0-9]+)?$' then
        booking_daily_rate := greatest(0, trim(coalesce(payload ->> 'dailyRate', listing_snapshot ->> 'dailyRate', listing_snapshot ->> 'priceValue'))::numeric);
    end if;

    if booking_daily_rate <= 0 then
        raise exception 'Rental daily rate is invalid.' using errcode = '22023';
    end if;

    computed_service_fee := greatest(25, round((booking_daily_rate * booking_days) * 0.12, 2));
    computed_total := round((booking_daily_rate * booking_days) + computed_service_fee, 2);

    if booking_guest_name = '' then
        booking_guest_name := 'Guest';
    end if;

    if booking_guest_email = '' then
        booking_guest_email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
    end if;

    if booking_guest_email = '' then
        raise exception 'Guest email is required.' using errcode = '22023';
    end if;

    if booking_currency = '' then
        booking_currency := 'USD';
    end if;

    if booking_currency !~ '^[A-Z]{3}$' then
        raise exception 'Booking currency is invalid.' using errcode = '22023';
    end if;

    if host_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        parsed_host_id := host_ref::uuid;
    end if;

    insert into public.vehicle_rental_bookings (
        listing_public_id,
        listing_title,
        listing_payload,
        host_user_id,
        host_name,
        guest_user_id,
        guest_name,
        guest_email,
        pickup_date,
        return_date,
        trip_days,
        daily_rate,
        service_fee,
        total,
        currency,
        status,
        booking_payload
    )
    values (
        listing_ref,
        booking_title,
        listing_snapshot,
        parsed_host_id,
        nullif(booking_host_name, ''),
        caller_id,
        booking_guest_name,
        booking_guest_email,
        booking_pickup,
        booking_return,
        booking_days,
        booking_daily_rate,
        computed_service_fee,
        computed_total,
        booking_currency,
        'confirmed',
        payload || jsonb_build_object(
            'computedStatus', 'confirmed',
            'computedTripDays', booking_days,
            'computedDailyRate', booking_daily_rate,
            'computedServiceFee', computed_service_fee,
            'computedTotal', computed_total
        )
    )
    returning * into result_row;

    return result_row;
end;
$$;

grant execute on function public.create_vehicle_rental_booking(text, jsonb) to authenticated;
