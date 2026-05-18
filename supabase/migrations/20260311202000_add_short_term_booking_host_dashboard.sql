create or replace function public.get_host_short_term_bookings()
returns table (
    booking_public_id text,
    listing_public_id text,
    listing_title text,
    listing_city text,
    listing_country text,
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
        booking.booking_payload,
        listing.listing_payload,
        lower(trim(coalesce(listing.listing_payload -> 'realestate' ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on') as instant_book,
        booking.created_at,
        booking.updated_at
    from public.short_term_bookings booking
    join public.short_term_listings listing
      on listing.id = booking.listing_id
    where auth.uid() is not null
      and (booking.host_user_id = caller_id or public.is_admin_user())
    order by
        case booking.status
            when 'requested' then 0
            when 'confirmed' then 1
            when 'declined' then 2
            when 'cancelled' then 3
            else 4
        end,
        booking.checkin_date asc,
        booking.created_at desc;
end;
$$;

grant execute on function public.get_host_short_term_bookings() to authenticated;

create or replace function public.update_short_term_booking_status(
    p_booking_public_id text,
    p_next_status text
)
returns public.short_term_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
    caller_id uuid := auth.uid();
    booking_ref text := trim(coalesce(p_booking_public_id, ''));
    next_status text := lower(trim(coalesce(p_next_status, '')));
    current_row public.short_term_bookings%rowtype;
    result_row public.short_term_bookings%rowtype;
    is_admin boolean := false;
begin
    if caller_id is null then
        raise exception 'Authentication required.' using errcode = '42501';
    end if;

    if booking_ref = '' then
        raise exception 'Booking is required.' using errcode = '22023';
    end if;

    if next_status not in ('confirmed', 'declined', 'cancelled') then
        raise exception 'Unsupported booking status.' using errcode = '22023';
    end if;

    is_admin := public.is_admin_user();

    select *
    into current_row
    from public.short_term_bookings
    where public_id = booking_ref or id::text = booking_ref
    for update;

    if not found then
        raise exception 'Booking not found.' using errcode = '22023';
    end if;

    if current_row.host_user_id <> caller_id and is_admin = false then
        raise exception 'Host access required.' using errcode = '42501';
    end if;

    if current_row.status in ('declined', 'cancelled') and is_admin = false then
        raise exception 'Closed bookings cannot be reopened.' using errcode = '22023';
    end if;

    if current_row.status = 'confirmed' and next_status = 'declined' and is_admin = false then
        raise exception 'Confirmed bookings can only be cancelled.' using errcode = '22023';
    end if;

    if next_status = 'confirmed' then
        lock table public.short_term_bookings in share row exclusive mode;

        if exists (
            select 1
            from public.short_term_bookings existing
            where existing.listing_id = current_row.listing_id
              and existing.id <> current_row.id
              and existing.status = 'confirmed'
              and current_row.checkin_date < existing.checkout_date
              and current_row.checkout_date > existing.checkin_date
        ) then
            raise exception 'Those dates already have a confirmed booking.' using errcode = '23505';
        end if;
    end if;

    update public.short_term_bookings
    set
        status = next_status,
        booking_payload = coalesce(booking_payload, '{}'::jsonb) || jsonb_build_object(
            'statusUpdatedAt', timezone('utc', now()),
            'statusUpdatedBy', caller_id::text,
            'previousStatus', current_row.status
        )
    where id = current_row.id
    returning * into result_row;

    return result_row;
end;
$$;

grant execute on function public.update_short_term_booking_status(text, text) to authenticated;
