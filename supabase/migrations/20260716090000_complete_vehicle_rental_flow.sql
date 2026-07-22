-- Complete the vehicle-rental flow with authoritative listings, booking holds,
-- guest history, and rental-specific in-app conversations.

create or replace function public.create_vehicle_rental_listing(listing_payload jsonb)
returns public.marketplace_listings
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    payload jsonb := coalesce(listing_payload, '{}'::jsonb);
    profile_row public.profiles%rowtype;
    approved_application_id uuid;
    marketplace_profile_ref uuid;
    listing_title text := trim(coalesce(payload ->> 'title', ''));
    listing_description text := trim(coalesce(payload ->> 'description', ''));
    listing_city text := trim(coalesce(payload ->> 'city', ''));
    listing_country text := trim(coalesce(payload ->> 'country', ''));
    listing_make text := trim(coalesce(payload ->> 'make', payload -> 'vehicle' ->> 'make', ''));
    listing_model text := trim(coalesce(payload ->> 'model', payload -> 'vehicle' ->> 'model', ''));
    listing_price numeric(12, 2);
    listing_currency text := upper(trim(coalesce(payload ->> 'currency', 'USD')));
    instant_book boolean := false;
    authoritative_payload jsonb;
    media_urls text[] := '{}';
    result_row public.marketplace_listings;
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
        raise exception 'Host approval required before listing a rental vehicle.' using errcode = '42501';
    end if;

    if coalesce(profile_row.host_email_verified, false) = false then
        raise exception 'Verified email required before listing a rental vehicle.' using errcode = '42501';
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

    if listing_title = '' or listing_description = '' then
        raise exception 'Vehicle title and rental description are required.' using errcode = '22023';
    end if;

    if listing_city = '' or listing_country = '' then
        raise exception 'Rental city and country are required.' using errcode = '22023';
    end if;

    if listing_make = '' or listing_model = '' then
        raise exception 'Vehicle make and model are required.' using errcode = '22023';
    end if;

    if trim(coalesce(payload ->> 'dailyRate', payload ->> 'priceValue', payload ->> 'price', '')) !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception 'A valid daily rate is required.' using errcode = '22023';
    end if;
    listing_price := trim(coalesce(payload ->> 'dailyRate', payload ->> 'priceValue', payload ->> 'price'))::numeric;
    if listing_price <= 0 then
        raise exception 'Daily rate must be greater than zero.' using errcode = '22023';
    end if;

    if listing_currency !~ '^[A-Z]{3}$' then
        raise exception 'Rental currency is invalid.' using errcode = '22023';
    end if;

    instant_book := lower(trim(coalesce(payload ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');

    if jsonb_typeof(coalesce(payload -> 'images', '[]'::jsonb)) = 'array' then
        select coalesce(array_agg(trim(media.value)) filter (where trim(media.value) <> ''), '{}')
        into media_urls
        from (
            select value
            from jsonb_array_elements_text(payload -> 'images') as image_values(value)
            limit 5
        ) media;
    end if;

    select id
    into marketplace_profile_ref
    from public.marketplace_profiles
    where user_id = caller_id
    limit 1;

    authoritative_payload := payload || jsonb_build_object(
        'category', 'rentals',
        'rentalMarket', 'peer',
        'isCustomVehicleListing', true,
        'hostUserId', caller_id::text,
        'userId', caller_id::text,
        'hostEmail', lower(trim(coalesce(auth.jwt() ->> 'email', ''))),
        'instantBook', instant_book,
        'dailyRate', listing_price,
        'priceValue', listing_price,
        'currency', listing_currency,
        'status', 'published'
    );

    insert into public.marketplace_listings (
        user_id,
        marketplace_profile_id,
        category,
        subcategory,
        title,
        description,
        price,
        currency,
        city,
        country,
        status,
        placement,
        featured,
        media_urls,
        primary_media_url,
        listing_payload
    )
    values (
        caller_id,
        marketplace_profile_ref,
        'vehicles',
        'rentals',
        listing_title,
        listing_description,
        listing_price,
        listing_currency,
        listing_city,
        listing_country,
        'published',
        'market',
        false,
        media_urls,
        nullif(coalesce(media_urls[1], ''), ''),
        authoritative_payload
    )
    returning * into result_row;

    return result_row;
end;
$$;
grant execute on function public.create_vehicle_rental_listing(jsonb) to authenticated;
alter table public.vehicle_rental_bookings
    add column if not exists hold_expires_at timestamptz;
create index if not exists vehicle_rental_bookings_active_hold_idx
    on public.vehicle_rental_bookings (listing_public_id, hold_expires_at, pickup_date, return_date)
    where status in ('requested', 'confirmed')
      and payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'paid');
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
    listing_row public.marketplace_listings%rowtype;
    listing_snapshot jsonb;
    host_profile public.profiles%rowtype;
    booking_pickup date;
    booking_return date;
    booking_days integer;
    booking_daily_rate numeric(12, 2);
    computed_service_fee numeric(12, 2);
    computed_total numeric(12, 2);
    booking_guest_name text := trim(coalesce(payload ->> 'guestName', ''));
    booking_guest_email text := lower(trim(coalesce(payload ->> 'guestEmail', auth.jwt() ->> 'email', '')));
    booking_guest_phone text := trim(coalesce(payload ->> 'guestPhone', payload ->> 'contactPhone', ''));
    booking_driver_name text := trim(coalesce(payload ->> 'driverName', payload ->> 'guestName', ''));
    booking_license_number text := trim(coalesce(payload ->> 'driverLicenseNumber', ''));
    booking_license_region text := trim(coalesce(payload ->> 'driverLicenseRegion', ''));
    booking_host_name text;
    booking_host_email text;
    host_auth_email text;
    booking_currency text;
    min_trip_days integer := 1;
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

    select *
    into listing_row
    from public.marketplace_listings
    where (public_id = listing_ref or id::text = listing_ref)
      and category = 'vehicles'
      and subcategory = 'rentals'
      and status = 'published'
    limit 1;

    if not found then
        raise exception 'This rental is not published or no longer available.' using errcode = '22023';
    end if;

    if listing_row.user_id = caller_id then
        raise exception 'Hosts cannot book their own rental vehicle.' using errcode = '42501';
    end if;

    listing_ref := listing_row.public_id;
    listing_snapshot := coalesce(listing_row.listing_payload, '{}'::jsonb) || jsonb_build_object(
        'id', listing_row.public_id,
        'title', listing_row.title,
        'description', coalesce(listing_row.description, ''),
        'city', coalesce(listing_row.city, ''),
        'country', coalesce(listing_row.country, ''),
        'hostUserId', listing_row.user_id::text,
        'userId', listing_row.user_id::text,
        'dailyRate', listing_row.price,
        'priceValue', listing_row.price,
        'currency', listing_row.currency
    );

    select *
    into host_profile
    from public.profiles
    where id = listing_row.user_id;

    select lower(trim(coalesce(email, '')))
    into host_auth_email
    from auth.users
    where id = listing_row.user_id;

    booking_host_name := trim(coalesce(
        listing_snapshot ->> 'hostName',
        listing_snapshot ->> 'seller',
        host_profile.full_name,
        host_profile.first_name,
        'Host'
    ));
    booking_host_email := lower(trim(coalesce(host_auth_email, listing_snapshot ->> 'hostEmail', '')));
    booking_currency := upper(trim(coalesce(listing_row.currency, 'USD')));

    booking_pickup := nullif(trim(coalesce(payload ->> 'pickupDate', payload ->> 'startDate', '')), '')::date;
    booking_return := nullif(trim(coalesce(payload ->> 'returnDate', payload ->> 'endDate', '')), '')::date;

    if booking_pickup is null or booking_return is null or booking_return <= booking_pickup then
        raise exception 'Return date must be after the pick-up date.' using errcode = '22023';
    end if;
    if booking_pickup < current_date then
        raise exception 'Pick-up date cannot be in the past.' using errcode = '22023';
    end if;

    booking_days := booking_return - booking_pickup;
    if trim(coalesce(listing_snapshot ->> 'minimumTripDays', '')) ~ '^[0-9]+$' then
        min_trip_days := greatest(1, (listing_snapshot ->> 'minimumTripDays')::integer);
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

    if booking_guest_email = '' then
        raise exception 'Guest email is required.' using errcode = '22023';
    end if;
    if booking_guest_phone = '' then
        raise exception 'Guest phone is required.' using errcode = '22023';
    end if;
    if booking_driver_name = '' or booking_license_number = '' or booking_license_region = '' then
        raise exception 'Driver and license details are required.' using errcode = '22023';
    end if;
    if booking_guest_name = '' then
        booking_guest_name := 'Guest';
    end if;

    booking_daily_rate := listing_row.price;
    if booking_daily_rate is null or booking_daily_rate <= 0 then
        raise exception 'Rental daily rate is invalid.' using errcode = '22023';
    end if;
    if booking_currency !~ '^[A-Z]{3}$' then
        raise exception 'Booking currency is invalid.' using errcode = '22023';
    end if;

    computed_service_fee := greatest(25, round((booking_daily_rate * booking_days) * 0.12, 2));
    computed_total := round((booking_daily_rate * booking_days) + computed_service_fee, 2);
    instant_book := lower(trim(coalesce(listing_snapshot ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');
    computed_status := case when instant_book then 'confirmed' else 'requested' end;

    lock table public.vehicle_rental_bookings in share row exclusive mode;

    if exists (
        select 1
        from public.vehicle_rental_bookings existing
        where existing.listing_public_id = listing_ref
          and existing.status in ('requested', 'confirmed')
          and existing.payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'paid')
          and (
              existing.payment_status in ('authorized', 'processing', 'paid')
              or coalesce(existing.hold_expires_at, existing.created_at + interval '30 minutes') > timezone('utc', now())
          )
          and booking_pickup < existing.return_date
          and booking_return > existing.pickup_date
    ) then
        raise exception 'Those dates are already booked or temporarily held.' using errcode = '23505';
    end if;

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
        payment_status,
        hold_expires_at,
        booking_payload
    )
    values (
        listing_ref,
        listing_row.title,
        listing_snapshot,
        listing_row.user_id,
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
        'unpaid',
        timezone('utc', now()) + interval '30 minutes',
        payload || jsonb_build_object(
            'listingId', listing_ref,
            'listingPublicId', listing_ref,
            'listingTitle', listing_row.title,
            'instantBook', instant_book,
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
language sql
security definer
set search_path = public
stable
as $$
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
    where booking.listing_public_id = trim(coalesce(p_listing_public_id, ''))
      and booking.status in ('requested', 'confirmed')
      and booking.payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'paid', 'processing')
      and (
          booking.payment_status in ('authorized', 'paid', 'processing')
          or coalesce(booking.hold_expires_at, booking.created_at + interval '30 minutes') > timezone('utc', now())
      )
    order by booking.pickup_date asc;
$$;
grant execute on function public.get_vehicle_rental_bookings_for_listing(text) to anon, authenticated;
create or replace function public.get_my_vehicle_rental_bookings()
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
language sql
security definer
set search_path = public
stable
as $$
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
    where booking.guest_user_id = auth.uid()
    order by booking.created_at desc;
$$;
grant execute on function public.get_my_vehicle_rental_bookings() to authenticated;
alter table public.marketplace_conversations
    add column if not exists booking_type text not null default 'short_term',
    add column if not exists vehicle_rental_booking_id uuid references public.vehicle_rental_bookings(id) on delete set null;
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'marketplace_conversations_booking_type_check'
          and conrelid = 'public.marketplace_conversations'::regclass
    ) then
        alter table public.marketplace_conversations
            add constraint marketplace_conversations_booking_type_check
            check (booking_type in ('short_term', 'vehicle_rental'));
    end if;
end;
$$;
create unique index if not exists marketplace_conversations_vehicle_booking_unique
    on public.marketplace_conversations (vehicle_rental_booking_id)
    where vehicle_rental_booking_id is not null;
create or replace function public.get_or_create_vehicle_rental_booking_conversation(
    p_booking_public_id text
)
returns table (
    conversation_public_id text,
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    guest_display_name text,
    host_display_name text,
    other_display_name text,
    created_at timestamptz,
    last_message_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    booking_ref text := trim(coalesce(p_booking_public_id, ''));
    booking_row public.vehicle_rental_bookings%rowtype;
    conversation_row public.marketplace_conversations%rowtype;
    is_admin boolean := false;
begin
    if caller_id is null then
        raise exception 'Log in to message the host or guest.' using errcode = '42501';
    end if;
    if booking_ref = '' then
        raise exception 'Vehicle rental booking is required.' using errcode = '22023';
    end if;

    select *
    into booking_row
    from public.vehicle_rental_bookings
    where public_id = booking_ref or id::text = booking_ref
    limit 1;

    if not found then
        raise exception 'Vehicle rental booking not found.' using errcode = '22023';
    end if;
    if booking_row.guest_user_id is null or booking_row.host_user_id is null then
        raise exception 'This rental booking is missing a guest or host account.' using errcode = '42501';
    end if;

    is_admin := public.is_admin_user();
    if caller_id <> booking_row.guest_user_id and caller_id <> booking_row.host_user_id and is_admin = false then
        raise exception 'Only the guest and host can open this conversation.' using errcode = '42501';
    end if;

    insert into public.marketplace_conversations (
        booking_type,
        vehicle_rental_booking_id,
        booking_public_id,
        listing_public_id,
        listing_title,
        guest_user_id,
        host_user_id,
        guest_display_name,
        host_display_name
    )
    values (
        'vehicle_rental',
        booking_row.id,
        booking_row.public_id,
        booking_row.listing_public_id,
        booking_row.listing_title,
        booking_row.guest_user_id,
        booking_row.host_user_id,
        coalesce(nullif(trim(booking_row.guest_name), ''), 'Guest'),
        coalesce(nullif(trim(booking_row.host_name), ''), 'Host')
    )
    on conflict (vehicle_rental_booking_id) where vehicle_rental_booking_id is not null do update
    set
        booking_type = 'vehicle_rental',
        booking_public_id = excluded.booking_public_id,
        listing_public_id = excluded.listing_public_id,
        listing_title = excluded.listing_title,
        guest_display_name = excluded.guest_display_name,
        host_display_name = excluded.host_display_name
    returning * into conversation_row;

    return query
    select
        conversation_row.public_id,
        conversation_row.booking_public_id,
        conversation_row.listing_public_id,
        conversation_row.listing_title,
        conversation_row.guest_display_name,
        conversation_row.host_display_name,
        case
            when caller_id = conversation_row.host_user_id then conversation_row.guest_display_name
            else conversation_row.host_display_name
        end,
        conversation_row.created_at,
        conversation_row.last_message_at;
end;
$$;
grant execute on function public.get_or_create_vehicle_rental_booking_conversation(text) to authenticated;
create or replace function public.get_my_marketplace_conversations()
returns table (
    conversation_public_id text,
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    guest_display_name text,
    host_display_name text,
    other_display_name text,
    other_role text,
    booking_status text,
    last_message_body text,
    last_message_at timestamptz,
    created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
    select
        conversation.public_id,
        conversation.booking_public_id,
        conversation.listing_public_id,
        conversation.listing_title,
        conversation.guest_display_name,
        conversation.host_display_name,
        case
            when auth.uid() = conversation.host_user_id then conversation.guest_display_name
            else conversation.host_display_name
        end,
        case
            when auth.uid() = conversation.host_user_id then 'guest'
            else 'host'
        end,
        coalesce(stay_booking.status, vehicle_booking.status, ''),
        coalesce(last_message.body, ''),
        conversation.last_message_at,
        conversation.created_at
    from public.marketplace_conversations conversation
    left join public.short_term_bookings stay_booking
      on stay_booking.id = conversation.booking_id
    left join public.vehicle_rental_bookings vehicle_booking
      on vehicle_booking.id = conversation.vehicle_rental_booking_id
    left join lateral (
        select message.body
        from public.marketplace_messages message
        where message.conversation_id = conversation.id
        order by message.created_at desc, message.id desc
        limit 1
    ) last_message on true
    where auth.uid() is not null
      and (
          auth.uid() = conversation.guest_user_id
          or auth.uid() = conversation.host_user_id
          or public.is_admin_user()
      )
    order by coalesce(conversation.last_message_at, conversation.created_at) desc;
$$;
grant execute on function public.get_my_marketplace_conversations() to authenticated;
