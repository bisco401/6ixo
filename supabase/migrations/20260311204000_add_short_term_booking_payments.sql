alter table public.short_term_bookings
    add column if not exists payment_status text not null default 'unpaid',
    add column if not exists stripe_payment_intent_id text,
    add column if not exists stripe_payment_amount_cents bigint,
    add column if not exists stripe_payment_currency text,
    add column if not exists stripe_payment_authorized_at timestamptz,
    add column if not exists stripe_payment_captured_at timestamptz,
    add column if not exists stripe_payment_cancelled_at timestamptz,
    add column if not exists stripe_payment_refunded_at timestamptz,
    add column if not exists payment_payload jsonb not null default '{}'::jsonb;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'short_term_bookings_payment_status_check'
    ) then
        alter table public.short_term_bookings
            add constraint short_term_bookings_payment_status_check
            check (payment_status in (
                'unpaid',
                'requires_payment_method',
                'authorized',
                'paid',
                'processing',
                'cancelled',
                'refunded',
                'failed'
            ));
    end if;
end $$;

create index if not exists short_term_bookings_payment_intent_idx
    on public.short_term_bookings (stripe_payment_intent_id)
    where stripe_payment_intent_id is not null;

drop function if exists public.get_host_short_term_bookings();

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
