-- Vehicle quotes, insurance review, timed trips, and delayed host settlement.
create table public.vehicle_listing_finance (
 listing_id uuid primary key references public.marketplace_listings(id) on delete cascade,
 time_zone text not null, pickup_time time not null, return_time time not null,
 tax_rules jsonb not null default '[]', coverage_summary text not null, coverage_expires_on date not null,
 min_driver_age integer not null check(min_driver_age between 18 and 100),
 included_distance_per_day integer not null check(included_distance_per_day>=0),
 distance_unit text not null check(distance_unit in ('km','mi')),
 excess_distance_rate_cents bigint not null check(excess_distance_rate_cents>=0),
 delivery_fee_cents bigint not null default 0 check(delivery_fee_cents>=0),
 pickup_instructions text not null, return_instructions text not null, support_contact text not null,
 enabled boolean not null default false, review_notes text not null,
 reviewed_by uuid not null references auth.users(id), reviewed_at timestamptz not null default now()
);
alter table vehicle_listing_finance enable row level security;
revoke all on vehicle_listing_finance from public,anon,authenticated;
grant select on vehicle_listing_finance to authenticated; grant all on vehicle_listing_finance to service_role;
create policy vehicle_listing_finance_read on vehicle_listing_finance for select to authenticated using(public.is_admin_user() or exists(select 1 from marketplace_listings l where l.id=listing_id and l.user_id=auth.uid()));

create table public.vehicle_booking_finance (
 booking_type text not null default 'vehicle_rental' check(booking_type='vehicle_rental'),
 booking_id uuid primary key references public.vehicle_rental_bookings(id),
 booking_public_id text not null unique, host_user_id uuid not null references auth.users(id),
 currency text not null, total_cents bigint not null check(total_cents>0),
 service_fee_cents bigint not null check(service_fee_cents>=0),
 tax_cents bigint not null check(tax_cents>=0), host_amount_cents bigint not null check(host_amount_cents>0),
 tax_breakdown jsonb not null, checkin_at timestamptz not null,
 cancellation_deadline timestamptz not null, payout_due_at timestamptz not null,
 stripe_destination text, stripe_transfer_id text unique, stripe_charge_id text,
 payout_status text not null default 'pending' check(payout_status in ('pending','transferred','held','reversed','cancelled')),
 last_error text, attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 transferred_at timestamptz, reversed_at timestamptz, created_at timestamptz not null default now()
);
alter table public.vehicle_booking_finance enable row level security;
revoke all on public.vehicle_booking_finance from public,anon,authenticated;
grant select on public.vehicle_booking_finance to authenticated;
grant all on public.vehicle_booking_finance to service_role;
create policy vehicle_booking_finance_participant_read on public.vehicle_booking_finance for select to authenticated using(public.is_admin_user() or exists(select 1 from public.vehicle_rental_bookings b where b.id=booking_id and auth.uid() in(b.host_user_id,b.guest_user_id)));
create index vehicle_payout_due on public.vehicle_booking_finance(payout_due_at,next_attempt_at) where payout_status in ('pending','held','transferred');



create or replace function public.configure_vehicle_listing_finance(p_listing_id uuid,p_setup jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare rule jsonb; s jsonb:=coalesce(p_setup,'{}');
begin
 if not public.is_admin_user() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if not exists(select 1 from marketplace_listings where id=p_listing_id and category='vehicles' and subcategory='rentals') then raise exception 'Car rental listing required.'; end if;
 if not exists(select 1 from pg_timezone_names where name=s->>'timeZone') then raise exception 'A valid vehicle time zone is required.'; end if;
 if length(trim(coalesce(s->>'reviewNotes','')))<10 or length(trim(coalesce(s->>'coverageSummary','')))<10
 or length(trim(coalesce(s->>'pickupInstructions','')))<5 or length(trim(coalesce(s->>'returnInstructions','')))<5
 or length(trim(coalesce(s->>'supportContact','')))<5 or (s->>'coverageExpiresOn')::date<current_date
 or not coalesce((s->>'insuranceReviewed')::boolean,false) then raise exception 'Review rental-use insurance, expiry, pickup/return instructions, and support before enabling bookings.'; end if;
 if coalesce((s->>'minDriverAge')::integer,0) not between 18 and 100 or coalesce(s->>'pickupTime','')='' or coalesce(s->>'returnTime','')='' then raise exception 'Driver age and local pickup/return times are required.'; end if;
 if jsonb_typeof(s->'taxRules') is distinct from 'array' or jsonb_array_length(s->'taxRules')>10 then raise exception 'Review the vehicle rental taxes.'; end if;
 for rule in select * from jsonb_array_elements(s->'taxRules') loop
  if length(trim(coalesce(rule->>'label','')))<2 or coalesce(rule->>'recipient','') not in ('host','platform') or coalesce(rule->>'kind','') not in ('percent','per_day')
  or coalesce(rule->>'rate','') !~ '^[0-9]+(\.[0-9]{1,4})?$' or (rule->>'rate')::numeric>100 then raise exception 'Invalid vehicle tax rule.'; end if;
  if rule->>'kind'='percent' and not(coalesce((rule->>'rental')::boolean,false) or coalesce((rule->>'delivery')::boolean,false) or coalesce((rule->>'service')::boolean,false)) then raise exception 'Select the taxable charges.'; end if;
 end loop;
 insert into vehicle_listing_finance(listing_id,time_zone,pickup_time,return_time,tax_rules,coverage_summary,coverage_expires_on,min_driver_age,included_distance_per_day,distance_unit,excess_distance_rate_cents,delivery_fee_cents,pickup_instructions,return_instructions,support_contact,enabled,review_notes,reviewed_by)
 values(p_listing_id,s->>'timeZone',(s->>'pickupTime')::time,(s->>'returnTime')::time,s->'taxRules',s->>'coverageSummary',(s->>'coverageExpiresOn')::date,(s->>'minDriverAge')::integer,
 (s->>'includedDistancePerDay')::integer,s->>'distanceUnit',round((s->>'excessDistanceRate')::numeric*100),round(coalesce((s->>'deliveryFee')::numeric,0)*100),s->>'pickupInstructions',s->>'returnInstructions',s->>'supportContact',coalesce((s->>'enabled')::boolean,false),s->>'reviewNotes',auth.uid())
 on conflict(listing_id) do update set time_zone=excluded.time_zone,pickup_time=excluded.pickup_time,return_time=excluded.return_time,tax_rules=excluded.tax_rules,
 coverage_summary=excluded.coverage_summary,coverage_expires_on=excluded.coverage_expires_on,min_driver_age=excluded.min_driver_age,included_distance_per_day=excluded.included_distance_per_day,
 distance_unit=excluded.distance_unit,excess_distance_rate_cents=excluded.excess_distance_rate_cents,delivery_fee_cents=excluded.delivery_fee_cents,
 pickup_instructions=excluded.pickup_instructions,return_instructions=excluded.return_instructions,support_contact=excluded.support_contact,enabled=excluded.enabled,review_notes=excluded.review_notes,reviewed_by=excluded.reviewed_by,reviewed_at=now();
end $$;
revoke all on function public.configure_vehicle_listing_finance(uuid,jsonb) from public,anon;
grant execute on function public.configure_vehicle_listing_finance(uuid,jsonb) to authenticated;

create or replace function public.get_vehicle_rental_terms(p_listing_public_id text)
returns jsonb language sql security definer set search_path=public,pg_temp stable as $$
 select jsonb_build_object('timeZone',f.time_zone,'pickupTime',f.pickup_time,'returnTime',f.return_time,'taxRules',f.tax_rules,
 'coverageSummary',f.coverage_summary,'minDriverAge',f.min_driver_age,'includedDistancePerDay',f.included_distance_per_day,'distanceUnit',f.distance_unit,
 'excessDistanceRate',f.excess_distance_rate_cents/100.0,'deliveryFee',f.delivery_fee_cents/100.0,'serviceFeeRate',0.10)
 from vehicle_listing_finance f join marketplace_listings l on l.id=f.listing_id where l.public_id=p_listing_public_id and l.status='published' and f.enabled and f.coverage_expires_on>=current_date;
$$;
revoke all on function public.get_vehicle_rental_terms(text) from public;
grant execute on function public.get_vehicle_rental_terms(text) to anon,authenticated;

create or replace function public.assert_vehicle_listing_bookable(p_listing_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.marketplace_listings; a uuid;
begin
 select * into l from marketplace_listings where id=p_listing_id;
 if not found or l.category<>'vehicles' or l.subcategory<>'rentals' then raise exception 'Car rental listing required.'; end if;
 select id into a from vehicle_host_applications where user_id=l.user_id and status='approved' and ready_for_review;
 if a is null then raise exception 'Approved car rental host required.'; end if;
 perform public.assert_vehicle_application_complete(a);
 if not exists(select 1 from stripe_connected_accounts where user_id=l.user_id and details_submitted and payouts_enabled and metadata#>>'{capabilities,transfers}'='active') then raise exception 'Complete Stripe payout setup before accepting bookings.'; end if;
 if not exists(select 1 from vehicle_listing_finance where listing_id=l.id and enabled and coverage_expires_on>=current_date) then raise exception 'This car needs its insurance, tax, and pickup review before accepting bookings.'; end if;
 if l.price is null or l.price<=0 or coalesce(array_length(l.media_urls,1),0)=0 or exists(select 1 from unnest(l.media_urls) u where u !~ '^https://') then raise exception 'A daily price and saved vehicle photos are required.'; end if;
end $$;
revoke all on function public.assert_vehicle_listing_bookable(uuid) from public,anon,authenticated;

create or replace function public.create_vehicle_rental_listing(listing_payload jsonb)
returns public.marketplace_listings
language plpgsql
security definer
set search_path = public, pg_temp
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
    media_urls text[] := '{}'::text[];
    result_row public.marketplace_listings;
begin
    if caller_id is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
    select * into profile_row from public.profiles where id = caller_id;
    if not found then raise exception 'Profile not found.' using errcode = '42501'; end if;
    if coalesce(profile_row.vehicle_host_status, 'none') <> 'approved' then
        raise exception 'Car rental approval required before listing a rental vehicle.' using errcode = '42501';
    end if;
    if coalesce(profile_row.vehicle_host_email_verified, false) = false then
        raise exception 'Verified email required before listing a rental vehicle.' using errcode = '42501';
    end if;
    select id into approved_application_id
      from public.vehicle_host_applications
     where user_id = caller_id and status = 'approved'
     order by reviewed_at desc nulls last, submitted_at desc
     limit 1;
    if approved_application_id is null then raise exception 'Approved car rental application not found.' using errcode = '42501'; end if;
    if listing_title = '' or listing_description = '' then raise exception 'Vehicle title and rental description are required.' using errcode = '22023'; end if;
    if listing_city = '' or listing_country = '' then raise exception 'Rental city and country are required.' using errcode = '22023'; end if;
    if listing_make = '' or listing_model = '' then raise exception 'Vehicle make and model are required.' using errcode = '22023'; end if;
    if trim(coalesce(payload ->> 'dailyRate', payload ->> 'priceValue', payload ->> 'price', '')) !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception 'A valid daily rate is required.' using errcode = '22023';
    end if;
    listing_price := trim(coalesce(payload ->> 'dailyRate', payload ->> 'priceValue', payload ->> 'price'))::numeric;
    if listing_price <= 0 then raise exception 'Daily rate must be greater than zero.' using errcode = '22023'; end if;
    if listing_currency !~ '^[A-Z]{3}$' then raise exception 'Rental currency is invalid.' using errcode = '22023'; end if;
    instant_book := lower(trim(coalesce(payload ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');
    if jsonb_typeof(coalesce(payload -> 'images', '[]'::jsonb)) = 'array' then
        select coalesce(array_agg(trim(media.value)) filter (where trim(media.value) <> ''), '{}'::text[])
          into media_urls
          from (select value from jsonb_array_elements_text(payload -> 'images') as image_values(value) limit 5) media;
    end if;
    select id into marketplace_profile_ref from public.marketplace_profiles where user_id = caller_id limit 1;
    authoritative_payload := payload || jsonb_build_object(
        'category', 'rentals', 'rentalMarket', 'peer', 'isCustomVehicleListing', true,
        'hostUserId', caller_id::text, 'userId', caller_id::text,
        'hostEmail', lower(trim(coalesce(auth.jwt() ->> 'email', ''))),
        'instantBook', instant_book, 'dailyRate', listing_price, 'priceValue', listing_price,
        'currency', listing_currency, 'status', 'draft',
        'vehicleHostApplicationId', approved_application_id::text
    );
    insert into public.marketplace_listings (
        user_id, marketplace_profile_id, category, subcategory, title, description,
        price, currency, city, country, status, placement, featured, media_urls,
        primary_media_url, listing_payload
    ) values (
        caller_id, marketplace_profile_ref, 'vehicles', 'rentals', listing_title,
        listing_description, listing_price, listing_currency, listing_city,
        listing_country, 'draft', 'market', false, media_urls,
        nullif(coalesce(media_urls[1], ''), ''), authoritative_payload
    ) returning * into result_row;
    return result_row;
end;
$$;

revoke all on function public.create_vehicle_rental_listing(jsonb) from public, anon;
grant execute on function public.create_vehicle_rental_listing(jsonb) to authenticated;



create or replace function public.vehicle_publication_gate()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.category='vehicles' and new.subcategory='rentals' and new.status='published' then
  if tg_op='INSERT' then raise exception 'Save the car as a draft for review first.'; end if;
  perform public.assert_vehicle_listing_bookable(new.id);
  if new.user_id is distinct from old.user_id or new.category is distinct from old.category or new.subcategory is distinct from old.subcategory then raise exception 'Vehicle owner and category cannot change.'; end if;
 end if;
 return new;
end $$;
create trigger vehicle_publication_gate before insert or update of status on marketplace_listings for each row execute function vehicle_publication_gate();
revoke all on function public.vehicle_publication_gate() from public,anon,authenticated;

alter table vehicle_rental_bookings drop constraint vehicle_rental_bookings_date_check;
alter table vehicle_rental_bookings add constraint vehicle_rental_bookings_date_check check(return_date>=pickup_date);
alter table vehicle_rental_bookings drop constraint vehicle_rental_bookings_payment_status_check;
alter table vehicle_rental_bookings add constraint vehicle_rental_bookings_payment_status_check check(payment_status in ('unpaid','requires_payment_method','authorized','processing','paid','failed','cancelled','refunded','disputed'));
alter table vehicle_rental_bookings add column payment_action_token uuid,add column payment_action_expires_at timestamptz;
revoke insert,update,delete on vehicle_rental_bookings from authenticated,anon;

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
    terms public.vehicle_listing_finance;
    pickup_at timestamptz; return_at timestamptz;
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
    limit 1 for update;

    if not found then
        raise exception 'This rental is not published or no longer available.' using errcode = '22023';
    end if;

    if listing_row.user_id = caller_id then
        raise exception 'Hosts cannot book their own rental vehicle.' using errcode = '42501';
    end if;

    perform public.assert_vehicle_listing_bookable(listing_row.id);
    select * into terms from vehicle_listing_finance where listing_id=listing_row.id for share;
    if not exists(select 1 from auth.users where id=caller_id and email_confirmed_at is not null) then raise exception 'Verify your email before booking.'; end if;
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

    if booking_pickup is null or booking_return is null or booking_return < booking_pickup then
        raise exception 'Return date must be after the pick-up date.' using errcode = '22023';
    end if;
    if booking_pickup < current_date then
        raise exception 'Pick-up date cannot be in the past.' using errcode = '22023';
    end if;

    pickup_at := (booking_pickup+coalesce(nullif(payload->>'pickupTime','')::time,terms.pickup_time)) at time zone terms.time_zone;
    return_at := (booking_return+coalesce(nullif(payload->>'returnTime','')::time,terms.return_time)) at time zone terms.time_zone;
    if pickup_at<=now() or return_at<=pickup_at then raise exception 'Choose a future pickup and a later return time.'; end if;
    if booking_return>terms.coverage_expires_on then raise exception 'Insurance must cover the full trip.'; end if;
    if nullif(payload->>'driverBirthDate','') is null or nullif(payload->>'driverLicenseExpiry','') is null then raise exception 'Driver birth date and licence expiry are required.'; end if;
    if (payload->>'driverBirthDate')::date>booking_pickup-(terms.min_driver_age*interval '1 year') or (payload->>'driverLicenseExpiry')::date<booking_return then raise exception 'The driver must meet the age requirement and hold a licence valid for the full trip.'; end if;
    if booking_pickup<nullif(listing_snapshot->>'availabilityStart','')::date or booking_return>nullif(listing_snapshot->>'availabilityEnd','')::date then raise exception 'Trip is outside the host availability window.'; end if;
    booking_days := greatest(1,ceil(extract(epoch from return_at-pickup_at)/86400.0)::integer);
    payload := payload||jsonb_build_object('pickupAt',pickup_at,'returnAt',return_at,'rentalType','vehicle_rental');
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

    computed_service_fee := round((booking_daily_rate * booking_days) * 0.10, 2);
    computed_total := round((booking_daily_rate * booking_days) + computed_service_fee, 2);
    instant_book := lower(trim(coalesce(listing_snapshot ->> 'instantBook', 'false'))) in ('true', '1', 'yes', 'on');
    computed_status := case when instant_book then 'confirmed' else 'requested' end;

    -- The listing row lock serializes competing reservations for this car.

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
          and pickup_at < coalesce((existing.booking_payload->>'returnAt')::timestamptz,existing.return_date::timestamptz+interval '1 day')
          and return_at > coalesce((existing.booking_payload->>'pickupAt')::timestamptz,existing.pickup_date::timestamptz)
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


create or replace function public.snapshot_vehicle_booking_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare f public.vehicle_listing_finance; rule jsonb; tax bigint:=0; host_tax bigint:=0; amount bigint; basis numeric; lines jsonb:='[]'; delivery bigint:=0;
begin
 select f0.* into f from vehicle_listing_finance f0 join marketplace_listings l on l.id=f0.listing_id where l.public_id=new.listing_public_id;
 if not found or not f.enabled then raise exception 'Vehicle financial review is required.'; end if;
 if coalesce((new.booking_payload->>'deliveryRequested')::boolean,false) then delivery:=f.delivery_fee_cents; end if;
 for rule in select * from jsonb_array_elements(f.tax_rules) loop
  if rule->>'kind'='per_day' then amount:=round((rule->>'rate')::numeric*new.trip_days*100);
  else basis:=case when coalesce((rule->>'rental')::boolean,false) then new.daily_rate*new.trip_days else 0 end
   +case when coalesce((rule->>'delivery')::boolean,false) then delivery/100.0 else 0 end
   +case when coalesce((rule->>'service')::boolean,false) then new.service_fee else 0 end;
   amount:=round(basis*(rule->>'rate')::numeric);
  end if;
  tax:=tax+amount; if rule->>'recipient'='host' then host_tax:=host_tax+amount; end if;
  lines:=lines||jsonb_build_array(rule||jsonb_build_object('amountCents',amount));
 end loop;
 new.total:=round(new.daily_rate*new.trip_days+new.service_fee+(delivery+tax)/100.0,2);
 new.booking_payload:=new.booking_payload||jsonb_build_object('payoutMode','delayed_transfer','rentalType','vehicle_rental','serviceFeeRate',0.10,
 'taxAmountCents',tax,'taxBreakdown',lines,'deliveryFeeCents',delivery,'computedTotal',new.total,
 'hostAmountCents',round(new.daily_rate*new.trip_days*100)+delivery+host_tax,'vehicleTimeZone',f.time_zone,
 'cancellationDeadline',(new.booking_payload->>'pickupAt')::timestamptz-interval '24 hours','payoutDueAt',(new.booking_payload->>'pickupAt')::timestamptz+interval '24 hours',
 'includedDistance',f.included_distance_per_day*new.trip_days,'distanceUnit',f.distance_unit,'excessDistanceRateCents',f.excess_distance_rate_cents,
 'coverageSummary',f.coverage_summary,'pickupInstructions',f.pickup_instructions,'returnInstructions',f.return_instructions,'supportContact',f.support_contact,'financialTermsVersion',f.reviewed_at);
 return new;
end $$;
create trigger vehicle_finance_snapshot before insert on vehicle_rental_bookings for each row execute function snapshot_vehicle_booking_finance();
revoke all on function public.snapshot_vehicle_booking_finance() from public,anon,authenticated;

create or replace function public.insert_vehicle_booking_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.vehicle_booking_finance(booking_id,booking_public_id,host_user_id,currency,total_cents,service_fee_cents,tax_cents,host_amount_cents,tax_breakdown,checkin_at,cancellation_deadline,payout_due_at)
 values(new.id,new.public_id,new.host_user_id,new.currency,round(new.total*100),round(new.service_fee*100),(new.booking_payload->>'taxAmountCents')::bigint,(new.booking_payload->>'hostAmountCents')::bigint,new.booking_payload->'taxBreakdown',(new.booking_payload->>'pickupAt')::timestamptz,(new.booking_payload->>'cancellationDeadline')::timestamptz,(new.booking_payload->>'payoutDueAt')::timestamptz);
 return new;
end $$;
create trigger vehicle_finance_insert after insert on public.vehicle_rental_bookings for each row execute function public.insert_vehicle_booking_finance();
revoke all on function public.insert_vehicle_booking_finance() from public,anon,authenticated;

-- Only money handlers can change the status; their audit payload may grow, but the quote never changes.
create or replace function public.protect_vehicle_financial_quote()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if old.booking_payload->>'payoutMode'='delayed_transfer' and (new.host_user_id is distinct from old.host_user_id or new.guest_user_id is distinct from old.guest_user_id or new.daily_rate is distinct from old.daily_rate or new.trip_days is distinct from old.trip_days or new.listing_public_id is distinct from old.listing_public_id or new.total is distinct from old.total or new.service_fee is distinct from old.service_fee or new.currency is distinct from old.currency or new.booking_payload is distinct from old.booking_payload or new.pickup_date is distinct from old.pickup_date or new.return_date is distinct from old.return_date) then
  raise exception 'Booking financial terms are immutable. Cancel and create a new booking.';
 end if;
 return new;
end $$;
create trigger vehicle_finance_immutable before update on public.vehicle_rental_bookings for each row execute function public.protect_vehicle_financial_quote();
revoke all on function public.protect_vehicle_financial_quote() from public,anon,authenticated;


create or replace function public.get_vehicle_maintenance_bookings()
returns setof jsonb language sql security definer set search_path=public,pg_temp as $$
 select to_jsonb(b)||jsonb_build_object('finance',to_jsonb(f)) from public.vehicle_rental_bookings b
 join public.vehicle_booking_finance f on f.booking_id=b.id
 where f.next_attempt_at<=now() and (
  (f.payout_status in ('pending','held') and b.status='confirmed' and b.payment_status='paid' and f.payout_due_at<=now())
  or (f.stripe_transfer_id is not null and f.payout_status<>'reversed' and (b.status in ('cancelled','declined') or b.payment_status in ('refunded','disputed'))))
 order by f.next_attempt_at limit 10;
$$;
revoke all on function public.get_vehicle_maintenance_bookings() from public,anon,authenticated;
grant execute on function public.get_vehicle_maintenance_bookings() to service_role;


create or replace function public.guard_vehicle_payment_transition()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if old.payment_status='refunded' and new.payment_status<>'refunded' then return null; end if;
 if old.stripe_payment_intent_id is not distinct from new.stripe_payment_intent_id then
  if old.payment_status='paid' and new.payment_status in ('unpaid','requires_payment_method','authorized','processing','failed','cancelled')
   and not(new.status in ('cancelled','declined') and new.payment_status='processing' and (coalesce(new.payment_payload->>'stripeRefundId','')<>'' or coalesce(new.payment_payload->>'latePaymentRefundId','')<>'')) then return null; end if;
  if old.payment_status='authorized' and new.payment_status in ('unpaid','requires_payment_method','failed') then return null; end if;
 end if;
 new.payment_payload:=coalesce(old.payment_payload,'{}')||coalesce(new.payment_payload,'{}');return new;
end $$;


create trigger vehicle_payment_transition before update on vehicle_rental_bookings for each row execute function guard_vehicle_payment_transition();

create or replace function public.claim_vehicle_payment_action(p_booking_public_id text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare token uuid := gen_random_uuid();
begin
    update public.vehicle_rental_bookings set payment_action_token = token, payment_action_expires_at = now() + interval '5 minutes'
    where public_id = p_booking_public_id
      and (guest_user_id = p_actor_id or host_user_id = p_actor_id or exists (select 1 from public.profiles where id = p_actor_id and is_admin))
      and (payment_action_token is null or payment_action_expires_at < now());
    if not found then raise exception 'Another payment action is in progress. Refresh and retry.' using errcode = '40001'; end if;
    return token;
end;
$$;


create or replace function public.release_vehicle_payment_action(p_token uuid)
returns void language sql security definer set search_path=public,pg_temp as $$
 update vehicle_rental_bookings set payment_action_token=null,payment_action_expires_at=null where payment_action_token=p_token;
$$;
revoke all on function public.claim_vehicle_payment_action(text,uuid) from public,anon,authenticated;
revoke all on function public.release_vehicle_payment_action(uuid) from public,anon,authenticated;
grant execute on function public.claim_vehicle_payment_action(text,uuid) to service_role;
grant execute on function public.release_vehicle_payment_action(uuid) to service_role;
