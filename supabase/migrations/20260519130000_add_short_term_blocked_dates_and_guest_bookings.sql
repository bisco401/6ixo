create or replace function public.get_short_term_blocked_date_entries(p_listing_payload jsonb)
returns table (
    start_date date,
    end_date date
)
language sql
immutable
as $$
    with blocked_source as (
        select case
            when jsonb_typeof(coalesce(p_listing_payload -> 'realestate' -> 'blockedDates', '[]'::jsonb)) = 'array'
                then coalesce(p_listing_payload -> 'realestate' -> 'blockedDates', '[]'::jsonb)
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
        from public.get_short_term_blocked_date_entries(listing_row.listing_payload) blocked
        where booking_checkin < (blocked.end_date + 1)
          and booking_checkout > blocked.start_date
    ) then
        raise exception 'Those dates are blocked by the host.' using errcode = '23505';
    end if;

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
    with target_listing as (
        select *
        from public.short_term_listings listing
        where listing.status = 'published'
          and (listing.public_id = listing_ref or listing.id::text = listing_ref)
        limit 1
    ),
    existing_bookings as (
        select
            booking.public_id,
            booking.listing_public_id,
            booking.checkin_date,
            booking.checkout_date,
            booking.guest_count,
            booking.status,
            booking.created_at
        from public.short_term_bookings booking
        join target_listing listing
          on listing.id = booking.listing_id
        where booking.status in ('requested', 'confirmed')
    ),
    host_blocks as (
        select
            'blocked_' || listing.public_id || '_' || blocked.start_date::text || '_' || blocked.end_date::text as public_id,
            listing.public_id as listing_public_id,
            blocked.start_date as checkin_date,
            (blocked.end_date + 1) as checkout_date,
            0::integer as guest_count,
            'blocked'::text as status,
            listing.updated_at as created_at
        from target_listing listing
        cross join public.get_short_term_blocked_date_entries(listing.listing_payload) blocked
    )
    select *
    from (
        select * from existing_bookings
        union all
        select * from host_blocks
    ) entries
    order by entries.checkin_date asc;
end;
$$;

grant execute on function public.get_short_term_bookings_for_listing(text) to anon, authenticated;

create or replace function public.get_my_short_term_bookings()
returns table (
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    listing_city text,
    listing_country text,
    host_name text,
    guest_name text,
    guest_email text,
    guest_count integer,
    checkin_date date,
    checkout_date date,
    nights integer,
    nightly_rate numeric,
    cleaning_fee numeric,
    service_fee numeric,
    total numeric,
    currency text,
    note text,
    status text,
    payment_status text,
    stripe_payment_intent_id text,
    stripe_payment_amount_cents bigint,
    stripe_payment_currency text,
    stripe_payment_authorized_at timestamptz,
    stripe_payment_captured_at timestamptz,
    stripe_payment_cancelled_at timestamptz,
    stripe_payment_refunded_at timestamptz,
    payment_payload jsonb,
    booking_payload jsonb,
    listing_payload jsonb,
    instant_book boolean,
    created_at timestamptz,
    updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null then
        raise exception 'Authentication required.' using errcode = '42501';
    end if;

    return query
    select
        booking.public_id as booking_public_id,
        booking.listing_public_id,
        listing.title as listing_title,
        listing.city as listing_city,
        listing.country as listing_country,
        trim(coalesce(
            listing.listing_payload -> 'realestate' ->> 'hostName',
            listing.listing_payload ->> 'seller',
            'Host'
        )) as host_name,
        booking.guest_name,
        booking.guest_email,
        booking.guest_count,
        booking.checkin_date,
        booking.checkout_date,
        booking.nights,
        booking.nightly_rate,
        booking.cleaning_fee,
        booking.service_fee,
        booking.total,
        booking.currency,
        booking.note,
        booking.status,
        booking.payment_status,
        booking.stripe_payment_intent_id,
        booking.stripe_payment_amount_cents,
        booking.stripe_payment_currency,
        booking.stripe_payment_authorized_at,
        booking.stripe_payment_captured_at,
        booking.stripe_payment_cancelled_at,
        booking.stripe_payment_refunded_at,
        booking.payment_payload,
        booking.booking_payload,
        listing.listing_payload,
        lower(trim(coalesce(listing.listing_payload -> 'realestate' ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on') as instant_book,
        booking.created_at,
        booking.updated_at
    from public.short_term_bookings booking
    join public.short_term_listings listing
      on listing.id = booking.listing_id
    where booking.guest_user_id = caller_id
    order by
        case
            when booking.status in ('requested', 'confirmed') and booking.checkout_date >= current_date then 0
            when booking.status = 'requested' then 1
            when booking.status = 'confirmed' then 2
            when booking.status in ('declined', 'cancelled') then 4
            else 3
        end,
        booking.checkin_date asc,
        booking.created_at desc;
end;
$$;

grant execute on function public.get_my_short_term_bookings() to authenticated;
