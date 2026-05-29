alter table public.vehicle_rental_bookings
    add column if not exists guest_phone text,
    add column if not exists driver_name text,
    add column if not exists driver_license_number text,
    add column if not exists driver_license_region text,
    add column if not exists host_email text,
    add column if not exists approved_at timestamptz,
    add column if not exists declined_at timestamptz;

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
    booking_guest_phone text := trim(coalesce(payload ->> 'guestPhone', payload ->> 'contactPhone', ''));
    booking_driver_name text := trim(coalesce(payload ->> 'driverName', payload ->> 'guestName', ''));
    booking_license_number text := trim(coalesce(payload ->> 'driverLicenseNumber', ''));
    booking_license_region text := trim(coalesce(payload ->> 'driverLicenseRegion', ''));
    booking_host_name text := trim(coalesce(payload ->> 'hostName', listing_snapshot ->> 'seller', listing_snapshot ->> 'hostName', ''));
    booking_host_email text := lower(trim(coalesce(payload ->> 'hostEmail', listing_snapshot ->> 'hostEmail', listing_snapshot -> 'contact' ->> 'email', '')));
    booking_title text := trim(coalesce(payload ->> 'listingTitle', listing_snapshot ->> 'title', 'Vehicle rental'));
    booking_currency text := upper(trim(coalesce(payload ->> 'currency', listing_snapshot ->> 'currency', 'USD')));
    min_trip_days integer := 1;
    host_ref text := trim(coalesce(payload ->> 'hostUserId', listing_snapshot ->> 'hostUserId', listing_snapshot ->> 'userId', ''));
    parsed_host_id uuid;
    instant_book boolean := false;
    computed_status text := 'requested';
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
          and existing.payment_status in ('authorized', 'paid', 'processing')
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

    if booking_guest_phone = '' then
        raise exception 'Guest phone is required.' using errcode = '22023';
    end if;

    if booking_driver_name = '' or booking_license_number = '' or booking_license_region = '' then
        raise exception 'Driver and license details are required.' using errcode = '22023';
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

    instant_book := lower(trim(coalesce(payload ->> 'instantBook', listing_snapshot ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');
    computed_status := case when instant_book then 'confirmed' else 'requested' end;

    insert into public.vehicle_rental_bookings (
        listing_public_id,
        listing_title,
        listing_payload,
        host_user_id,
        host_name,
        host_email,
        guest_user_id,
        guest_name,
        guest_email,
        guest_phone,
        driver_name,
        driver_license_number,
        driver_license_region,
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
        nullif(booking_host_email, ''),
        caller_id,
        booking_guest_name,
        booking_guest_email,
        booking_guest_phone,
        booking_driver_name,
        booking_license_number,
        booking_license_region,
        booking_pickup,
        booking_return,
        booking_days,
        booking_daily_rate,
        computed_service_fee,
        computed_total,
        booking_currency,
        computed_status,
        payload || jsonb_build_object(
            'computedStatus', computed_status,
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

create or replace function public.get_vehicle_rental_bookings_for_listing(p_listing_public_id text)
returns table (
    public_id text,
    listing_public_id text,
    pickup_date date,
    return_date date,
    trip_days integer,
    status text,
    payment_status text,
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
        booking.pickup_date,
        booking.return_date,
        booking.trip_days,
        booking.status,
        booking.payment_status,
        booking.created_at
    from public.vehicle_rental_bookings booking
    where booking.listing_public_id = listing_ref
      and booking.status in ('requested', 'confirmed')
      and booking.payment_status in ('authorized', 'paid', 'processing')
    order by booking.pickup_date asc;
end;
$$;

grant execute on function public.get_vehicle_rental_bookings_for_listing(text) to anon, authenticated;

create or replace function public.get_host_vehicle_rental_bookings()
returns table (
    public_id text,
    listing_public_id text,
    listing_title text,
    host_name text,
    guest_name text,
    guest_email text,
    guest_phone text,
    driver_name text,
    driver_license_number text,
    driver_license_region text,
    pickup_date date,
    return_date date,
    trip_days integer,
    daily_rate numeric,
    service_fee numeric,
    total numeric,
    currency text,
    status text,
    payment_status text,
    stripe_payment_intent_id text,
    stripe_payment_amount_cents bigint,
    stripe_payment_currency text,
    stripe_payment_authorized_at timestamptz,
    stripe_payment_captured_at timestamptz,
    stripe_payment_cancelled_at timestamptz,
    stripe_payment_refunded_at timestamptz,
    booking_payload jsonb,
    listing_payload jsonb,
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
    caller_is_admin boolean := coalesce(public.is_admin_user(), false);
begin
    if caller_id is null then
        return;
    end if;

    return query
    select
        booking.public_id,
        booking.listing_public_id,
        booking.listing_title,
        booking.host_name,
        booking.guest_name,
        booking.guest_email,
        booking.guest_phone,
        booking.driver_name,
        booking.driver_license_number,
        booking.driver_license_region,
        booking.pickup_date,
        booking.return_date,
        booking.trip_days,
        booking.daily_rate,
        booking.service_fee,
        booking.total,
        booking.currency,
        booking.status,
        booking.payment_status,
        booking.stripe_payment_intent_id,
        booking.stripe_payment_amount_cents,
        booking.stripe_payment_currency,
        booking.stripe_payment_authorized_at,
        booking.stripe_payment_captured_at,
        booking.stripe_payment_cancelled_at,
        booking.stripe_payment_refunded_at,
        booking.booking_payload,
        booking.listing_payload,
        booking.created_at,
        booking.updated_at
    from public.vehicle_rental_bookings booking
    where caller_is_admin
       or booking.host_user_id = caller_id
    order by booking.created_at desc;
end;
$$;

grant execute on function public.get_host_vehicle_rental_bookings() to authenticated;
