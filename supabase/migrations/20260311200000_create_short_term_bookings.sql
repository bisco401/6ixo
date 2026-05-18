create table if not exists public.short_term_bookings (
    id uuid primary key default gen_random_uuid(),
    public_id text not null unique default ('stb_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 20)),
    listing_id uuid not null references public.short_term_listings(id) on delete cascade,
    listing_public_id text not null,
    guest_user_id uuid references auth.users(id) on delete set null,
    host_user_id uuid not null references auth.users(id) on delete cascade,
    host_application_id uuid references public.host_applications(id) on delete set null,
    guest_name text not null,
    guest_email text not null,
    guest_count integer not null,
    checkin_date date not null,
    checkout_date date not null,
    nights integer not null,
    nightly_rate numeric(12, 2) not null default 0,
    cleaning_fee numeric(12, 2) not null default 0,
    service_fee numeric(12, 2) not null default 0,
    total numeric(12, 2) not null default 0,
    currency text not null default 'USD',
    note text,
    status text not null default 'requested',
    booking_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    constraint short_term_bookings_date_check check (checkout_date > checkin_date),
    constraint short_term_bookings_guest_count_check check (guest_count > 0),
    constraint short_term_bookings_nights_check check (nights > 0),
    constraint short_term_bookings_status_check check (status in ('requested', 'confirmed', 'cancelled', 'declined'))
);

create index if not exists short_term_bookings_listing_dates_idx
    on public.short_term_bookings (listing_id, checkin_date, checkout_date)
    where status in ('requested', 'confirmed');

create index if not exists short_term_bookings_guest_idx
    on public.short_term_bookings (guest_user_id, created_at desc);

create index if not exists short_term_bookings_host_idx
    on public.short_term_bookings (host_user_id, created_at desc);

create or replace function public.short_term_bookings_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = timezone('utc', now());
    return new;
end;
$$;

drop trigger if exists short_term_bookings_set_updated_at on public.short_term_bookings;
create trigger short_term_bookings_set_updated_at
before update on public.short_term_bookings
for each row
execute function public.short_term_bookings_set_updated_at();

alter table public.short_term_bookings enable row level security;

drop policy if exists "short_term_bookings_participant_select" on public.short_term_bookings;
create policy "short_term_bookings_participant_select"
    on public.short_term_bookings
    for select
    to authenticated
    using (
        auth.uid() = guest_user_id
        or auth.uid() = host_user_id
        or public.is_admin_user()
    );

drop policy if exists "short_term_bookings_host_update" on public.short_term_bookings;
create policy "short_term_bookings_host_update"
    on public.short_term_bookings
    for update
    to authenticated
    using (auth.uid() = host_user_id or public.is_admin_user())
    with check (auth.uid() = host_user_id or public.is_admin_user());

grant select, update on public.short_term_bookings to authenticated;

create or replace function public.create_short_term_booking(
    p_listing_public_id text,
    booking_payload jsonb
)
returns public.short_term_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    payload jsonb := coalesce(booking_payload, '{}'::jsonb);
    listing_ref text := trim(coalesce(p_listing_public_id, payload ->> 'listingId', ''));
    listing_row public.short_term_listings%rowtype;
    listing_realestate jsonb;
    booking_checkin date;
    booking_checkout date;
    booking_nights integer;
    booking_guest_count integer;
    booking_guest_name text := trim(coalesce(payload ->> 'guestName', ''));
    booking_guest_email text := lower(trim(coalesce(payload ->> 'guestEmail', '')));
    booking_note text := trim(coalesce(payload ->> 'note', ''));
    min_stay integer := 1;
    max_guests integer;
    availability_start date;
    availability_end date;
    instant_book boolean := false;
    computed_status text := 'requested';
    computed_nightly_rate numeric(12, 2) := 0;
    computed_cleaning_fee numeric(12, 2) := 0;
    computed_service_fee numeric(12, 2) := 0;
    computed_total numeric(12, 2) := 0;
    result_row public.short_term_bookings;
begin
    if listing_ref = '' then
        raise exception 'Listing is required.' using errcode = '22023';
    end if;

    select *
    into listing_row
    from public.short_term_listings
    where status = 'published'
      and (public_id = listing_ref or id::text = listing_ref)
    limit 1;

    if not found then
        raise exception 'Short-term listing not found.' using errcode = '22023';
    end if;

    listing_realestate := coalesce(listing_row.listing_payload -> 'realestate', '{}'::jsonb);

    booking_checkin := nullif(trim(coalesce(payload ->> 'checkin', payload ->> 'startDate', '')), '')::date;
    booking_checkout := nullif(trim(coalesce(payload ->> 'checkout', payload ->> 'endDate', '')), '')::date;

    if booking_checkin is null or booking_checkout is null or booking_checkout <= booking_checkin then
        raise exception 'Checkout must be after check-in.' using errcode = '22023';
    end if;

    booking_nights := booking_checkout - booking_checkin;

    if trim(coalesce(payload ->> 'guests', payload ->> 'guestCount', '')) ~ '^[0-9]+$' then
        booking_guest_count := trim(coalesce(payload ->> 'guests', payload ->> 'guestCount'))::integer;
    end if;

    if booking_guest_count is null or booking_guest_count <= 0 then
        raise exception 'Guest count is required.' using errcode = '22023';
    end if;

    if booking_guest_name = '' then
        booking_guest_name := 'Guest';
    end if;

    if booking_guest_email = '' then
        booking_guest_email := lower(trim(coalesce(auth.jwt() ->> 'email', 'guest@6ixo.local')));
    end if;

    if trim(coalesce(listing_realestate ->> 'minStayNights', '')) ~ '^[0-9]+$' then
        min_stay := greatest(1, trim(listing_realestate ->> 'minStayNights')::integer);
    end if;

    if booking_nights < min_stay then
        raise exception 'This stay requires at least % nights.', min_stay using errcode = '22023';
    end if;

    if trim(coalesce(listing_realestate ->> 'maxGuests', '')) ~ '^[0-9]+$' then
        max_guests := trim(listing_realestate ->> 'maxGuests')::integer;
    end if;

    if max_guests is not null and booking_guest_count > max_guests then
        raise exception 'This stay allows up to % guests.', max_guests using errcode = '22023';
    end if;

    if trim(coalesce(listing_realestate ->> 'availabilityStart', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        availability_start := trim(listing_realestate ->> 'availabilityStart')::date;
    end if;

    if trim(coalesce(listing_realestate ->> 'availabilityEnd', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        availability_end := trim(listing_realestate ->> 'availabilityEnd')::date;
    end if;

    if availability_start is not null and booking_checkin < availability_start then
        raise exception 'Check-in is before the host availability window.' using errcode = '22023';
    end if;

    if availability_end is not null and booking_checkout > availability_end then
        raise exception 'Checkout is outside the host availability window.' using errcode = '22023';
    end if;

    lock table public.short_term_bookings in share row exclusive mode;

    if exists (
        select 1
        from public.short_term_bookings existing
        where existing.listing_id = listing_row.id
          and existing.status in ('requested', 'confirmed')
          and booking_checkin < existing.checkout_date
          and booking_checkout > existing.checkin_date
    ) then
        raise exception 'Those dates are already booked or requested.' using errcode = '23505';
    end if;

    instant_book := lower(trim(coalesce(listing_realestate ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');
    computed_status := case when instant_book then 'confirmed' else 'requested' end;
    computed_nightly_rate := greatest(0, coalesce(listing_row.price, 0));
    if lower(trim(coalesce(listing_realestate ->> 'priceTerm', ''))) in ('per_month', 'monthly', 'month') then
        computed_nightly_rate := round(computed_nightly_rate / 30, 2);
    elsif lower(trim(coalesce(listing_realestate ->> 'priceTerm', ''))) in ('per_week', 'weekly', 'week') then
        computed_nightly_rate := round(computed_nightly_rate / 7, 2);
    end if;

    if trim(coalesce(listing_realestate ->> 'cleaningFee', '')) ~ '^[0-9]+(\.[0-9]+)?$' then
        computed_cleaning_fee := greatest(0, trim(listing_realestate ->> 'cleaningFee')::numeric);
    end if;

    computed_service_fee := round((computed_nightly_rate * booking_nights) * 0.12, 2);
    computed_total := round((computed_nightly_rate * booking_nights) + computed_cleaning_fee + computed_service_fee, 2);

    insert into public.short_term_bookings (
        listing_id,
        listing_public_id,
        guest_user_id,
        host_user_id,
        host_application_id,
        guest_name,
        guest_email,
        guest_count,
        checkin_date,
        checkout_date,
        nights,
        nightly_rate,
        cleaning_fee,
        service_fee,
        total,
        currency,
        note,
        status,
        booking_payload
    )
    values (
        listing_row.id,
        listing_row.public_id,
        caller_id,
        listing_row.user_id,
        listing_row.host_application_id,
        booking_guest_name,
        booking_guest_email,
        booking_guest_count,
        booking_checkin,
        booking_checkout,
        booking_nights,
        computed_nightly_rate,
        computed_cleaning_fee,
        computed_service_fee,
        computed_total,
        coalesce(nullif(trim(listing_row.currency), ''), 'USD'),
        nullif(booking_note, ''),
        computed_status,
        payload || jsonb_build_object(
            'computedStatus', computed_status,
            'computedTotal', computed_total,
            'computedServiceFee', computed_service_fee
        )
    )
    returning * into result_row;

    return result_row;
end;
$$;

grant execute on function public.create_short_term_booking(text, jsonb) to anon, authenticated;

create or replace function public.get_short_term_bookings_for_listing(p_listing_public_id text)
returns table (
    public_id text,
    listing_public_id text,
    checkin_date date,
    checkout_date date,
    guest_count integer,
    status text,
    created_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
    listing_ref text := trim(coalesce(p_listing_public_id, ''));
begin
    if listing_ref = '' then
        return;
    end if;

    return query
    select
        booking.public_id,
        booking.listing_public_id,
        booking.checkin_date,
        booking.checkout_date,
        booking.guest_count,
        booking.status,
        booking.created_at
    from public.short_term_bookings booking
    join public.short_term_listings listing
      on listing.id = booking.listing_id
    where listing.status = 'published'
      and (listing.public_id = listing_ref or listing.id::text = listing_ref)
      and booking.status in ('requested', 'confirmed')
    order by booking.checkin_date asc;
end;
$$;

grant execute on function public.get_short_term_bookings_for_listing(text) to anon, authenticated;
