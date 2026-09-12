-- Set the guest service fee to 10% of nightly accommodation for new bookings.
-- Existing booking totals and financial snapshots retain their agreed amounts.

create or replace function public.create_short_term_booking(
    p_listing_public_id text,
    booking_payload jsonb
)
returns public.short_term_bookings
language plpgsql
security definer
set search_path = public, auth, pg_temp
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
    booking_guest_email text := '';
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
    if caller_id is null then
        raise exception 'Log in to book this stay.' using errcode = '28000';
    end if;
    if listing_ref = '' then
        raise exception 'Listing is required.' using errcode = '22023';
    end if;

    select *
      into listing_row
      from public.short_term_listings
     where status = 'published'
       and (public_id = listing_ref or id::text = listing_ref)
     limit 1
     for update;
    if not found then
        raise exception 'Short-term listing not found.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles where id = listing_row.user_id and host_status = 'approved') then
        raise exception 'This host is not currently approved.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.stripe_connected_accounts where user_id = listing_row.user_id and details_submitted and payouts_enabled and metadata #>> '{capabilities,transfers}' = 'active') then
        raise exception 'This host must complete payout setup before accepting bookings.' using errcode = '42501';
    end if;
    if listing_row.user_id = caller_id then
        raise exception 'Hosts cannot book their own stay.' using errcode = '42501';
    end if;

    select lower(trim(coalesce(user_row.email, '')))
      into booking_guest_email
      from auth.users user_row
     where user_row.id = caller_id;
    if coalesce(booking_guest_email, '') = '' then
        raise exception 'Your account email is required to book.' using errcode = '22023';
    end if;

    listing_realestate := coalesce(listing_row.listing_payload -> 'realestate', '{}'::jsonb);
    booking_checkin := nullif(trim(coalesce(payload ->> 'checkin', payload ->> 'startDate', '')), '')::date;
    booking_checkout := nullif(trim(coalesce(payload ->> 'checkout', payload ->> 'endDate', '')), '')::date;
    if booking_checkin is null or booking_checkout is null or booking_checkout <= booking_checkin then
        raise exception 'Checkout must be after check-in.' using errcode = '22023';
    end if;
    if booking_checkin < current_date then
        raise exception 'Check-in cannot be in the past.' using errcode = '22023';
    end if;
    booking_nights := booking_checkout - booking_checkin;

    if trim(coalesce(payload ->> 'guests', payload ->> 'guestCount', '')) ~ '^[0-9]+$' then
        booking_guest_count := trim(coalesce(payload ->> 'guests', payload ->> 'guestCount'))::integer;
    end if;
    if booking_guest_count is null or booking_guest_count <= 0 then
        raise exception 'Guest count is required.' using errcode = '22023';
    end if;
    if booking_guest_name = '' then booking_guest_name := 'Guest'; end if;

    if trim(coalesce(listing_realestate ->> 'minStayNights', '')) ~ '^[0-9]+$' then
        min_stay := greatest(1, (listing_realestate ->> 'minStayNights')::integer);
    end if;
    if booking_nights < min_stay then
        raise exception 'This stay requires at least % nights.', min_stay using errcode = '22023';
    end if;
    if trim(coalesce(listing_realestate ->> 'maxGuests', '')) ~ '^[0-9]+$' then
        max_guests := (listing_realestate ->> 'maxGuests')::integer;
    end if;
    if max_guests is not null and booking_guest_count > max_guests then
        raise exception 'This stay allows up to % guests.', max_guests using errcode = '22023';
    end if;

    if trim(coalesce(listing_realestate ->> 'availabilityStart', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        availability_start := (listing_realestate ->> 'availabilityStart')::date;
    end if;
    if trim(coalesce(listing_realestate ->> 'availabilityEnd', '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        availability_end := (listing_realestate ->> 'availabilityEnd')::date;
    end if;
    if availability_start is not null and booking_checkin < availability_start then
        raise exception 'Check-in is before the host availability window.' using errcode = '22023';
    end if;
    if availability_end is not null and booking_checkout > availability_end then
        raise exception 'Checkout is outside the host availability window.' using errcode = '22023';
    end if;

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
           and existing.payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'paid')
           and (
               existing.payment_status in ('authorized', 'processing', 'paid')
               or coalesce(existing.hold_expires_at, existing.created_at + interval '30 minutes') > timezone('utc', now())
           )
           and booking_checkin < existing.checkout_date
           and booking_checkout > existing.checkin_date
    ) then
        raise exception 'Those dates are already booked or temporarily held.' using errcode = '23505';
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
        computed_cleaning_fee := greatest(0, (listing_realestate ->> 'cleaningFee')::numeric);
    end if;
    computed_service_fee := round((computed_nightly_rate * booking_nights) * 0.10, 2);
    computed_total := round((computed_nightly_rate * booking_nights) + computed_cleaning_fee + computed_service_fee, 2);

    insert into public.short_term_bookings (
        listing_id, listing_public_id, guest_user_id, host_user_id, host_application_id,
        guest_name, guest_email, guest_count, checkin_date, checkout_date, nights,
        nightly_rate, cleaning_fee, service_fee, total, currency, note, status,
        payment_status, hold_expires_at, booking_payload
    ) values (
        listing_row.id, listing_row.public_id, caller_id, listing_row.user_id, listing_row.host_application_id,
        booking_guest_name, booking_guest_email, booking_guest_count, booking_checkin, booking_checkout, booking_nights,
        computed_nightly_rate, computed_cleaning_fee, computed_service_fee, computed_total,
        coalesce(nullif(trim(listing_row.currency), ''), 'USD'), nullif(booking_note, ''), computed_status,
        'unpaid', timezone('utc', now()) + interval '30 minutes',
        payload || jsonb_build_object(
            'computedStatus', computed_status,
            'computedTotal', computed_total,
            'computedServiceFee', computed_service_fee
        )
    ) returning * into result_row;
    return result_row;
end;
$$;

revoke all on function public.create_short_term_booking(text, jsonb) from public, anon;
grant execute on function public.create_short_term_booking(text, jsonb) to authenticated;

