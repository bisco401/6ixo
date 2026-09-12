-- Close the launch-critical rental gaps: authenticated short-term bookings,
-- expiring checkout holds, payment-aware availability, and host-owned listing
-- lifecycle controls.

alter table public.short_term_bookings
    add column if not exists hold_expires_at timestamptz;

create index if not exists short_term_bookings_active_hold_idx
    on public.short_term_bookings (listing_id, hold_expires_at, checkin_date, checkout_date)
    where status in ('requested', 'confirmed')
      and payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'paid');

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
    computed_service_fee := round((computed_nightly_rate * booking_nights) * 0.12, 2);
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
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    with target_listing as (
        select *
          from public.short_term_listings listing
         where listing.status = 'published'
           and (listing.public_id = trim(coalesce(p_listing_public_id, '')) or listing.id::text = trim(coalesce(p_listing_public_id, '')))
         limit 1
    ), active_bookings as (
        select booking.public_id, booking.listing_public_id, booking.checkin_date,
               booking.checkout_date, booking.guest_count, booking.status, booking.created_at
          from public.short_term_bookings booking
          join target_listing listing on listing.id = booking.listing_id
         where booking.status in ('requested', 'confirmed')
           and booking.payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'paid')
           and (
               booking.payment_status in ('authorized', 'processing', 'paid')
               or coalesce(booking.hold_expires_at, booking.created_at + interval '30 minutes') > timezone('utc', now())
           )
    ), host_blocks as (
        select 'blocked_' || listing.public_id || '_' || blocked.start_date::text || '_' || blocked.end_date::text,
               listing.public_id, blocked.start_date, blocked.end_date + 1, 0::integer,
               'blocked'::text, listing.updated_at
          from target_listing listing
          cross join public.get_short_term_blocked_date_entries(listing.listing_payload) blocked
    )
    select * from active_bookings
    union all
    select * from host_blocks
    order by checkin_date asc;
$$;

grant execute on function public.get_short_term_bookings_for_listing(text) to anon, authenticated;

-- Short-term listings need the same reversible pause state as vehicle listings.
alter table public.short_term_listings
    drop constraint if exists short_term_listings_status_check;
alter table public.short_term_listings
    add constraint short_term_listings_status_check
    check (status in ('draft', 'published', 'paused', 'archived'));

-- Public stays must be payable and must reference persistent public media.
create or replace function public.enforce_short_term_rental_launch_requirements()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if lower(coalesce(new.status, '')) = 'published' then
        if not exists (select 1 from public.profiles where id = new.user_id and host_status = 'approved' and host_email_verified) then
            raise exception 'Approved host account required.' using errcode = '42501';
        end if;
        if coalesce(new.price, 0) <= 0 then
            raise exception 'Short-term rental price must be greater than zero.' using errcode = '22023';
        end if;
        if jsonb_typeof(coalesce(new.listing_payload -> 'images', '[]'::jsonb)) <> 'array'
           or jsonb_array_length(
               case when jsonb_typeof(new.listing_payload -> 'images') = 'array'
                    then new.listing_payload -> 'images'
                    else '[]'::jsonb end
           ) = 0
           or exists (
               select 1
                 from jsonb_array_elements_text(
                     case when jsonb_typeof(new.listing_payload -> 'images') = 'array'
                          then new.listing_payload -> 'images'
                          else '[]'::jsonb end
                 ) media(url)
                where trim(media.url) !~ '^https://'
           ) then
            raise exception 'Published stays require at least one persistent HTTPS photo.' using errcode = '22023';
        end if;
        if trim(coalesce(new.listing_payload ->> 'video', '')) <> ''
           and trim(new.listing_payload ->> 'video') !~ '^https://' then
            raise exception 'Published stay videos must use a persistent HTTPS URL.' using errcode = '22023';
        end if;
        if not exists (
            select 1
              from public.stripe_connected_accounts account
             where account.user_id = new.user_id
               and coalesce(account.details_submitted, false)
               and coalesce(account.payouts_enabled, false)
               and account.metadata #>> '{capabilities,transfers}' = 'active'
        ) then
            raise exception 'Complete Stripe payout onboarding before publishing a paid stay.' using errcode = '42501';
        end if;
    end if;
    return new;
end;
$$;

revoke all on function public.enforce_short_term_rental_launch_requirements() from public, anon, authenticated;

drop trigger if exists short_term_listings_enforce_launch_requirements on public.short_term_listings;
create trigger short_term_listings_enforce_launch_requirements
before insert or update of status on public.short_term_listings
for each row execute function public.enforce_short_term_rental_launch_requirements();

create or replace function public.get_my_rental_listings()
returns table (
    listing_type text,
    public_id text,
    title text,
    city text,
    country text,
    status text,
    listing_payload jsonb,
    updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select 'short_term'::text, listing.public_id, listing.title, listing.city,
           listing.country, listing.status, listing.listing_payload, listing.updated_at
      from public.short_term_listings listing
     where listing.user_id = auth.uid()
    order by updated_at desc;
$$;

revoke all on function public.get_my_rental_listings() from public, anon;
grant execute on function public.get_my_rental_listings() to authenticated;

-- This management endpoint covers stays; vehicle approval rules remain separate.
create or replace function public.manage_my_rental_listing(
    p_listing_type text, p_listing_public_id text, p_action text, p_updates jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    listing public.short_term_listings%rowtype;
    updates jsonb := coalesce(p_updates, '{}'::jsonb);
    details jsonb;
    action_value text := lower(trim(coalesce(p_action, '')));
    next_status text;
begin
    if auth.uid() is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
    if p_listing_type <> 'short_term' or p_listing_type is null then
        raise exception 'Short-term listing management required.' using errcode = '22023';
    end if;
    select * into listing from public.short_term_listings
    where public_id = p_listing_public_id and user_id = auth.uid() for update;
    if not found then raise exception 'Owned stay listing not found.' using errcode = 'P0002'; end if;
    if action_value in ('publish', 'pause', 'archive') then
        next_status := case action_value when 'publish' then 'published' when 'pause' then 'paused' else 'archived' end;
        update public.short_term_listings set status = next_status,
            listing_payload = listing.listing_payload || jsonb_build_object('status', next_status)
        where id = listing.id returning * into listing;
    elsif action_value = 'update_availability' then
        details := coalesce(listing.listing_payload -> 'realestate', '{}'::jsonb);
        if updates ? 'availabilityStart' then details := details || jsonb_build_object('availabilityStart', trim(updates ->> 'availabilityStart')); end if;
        if updates ? 'availabilityEnd' then details := details || jsonb_build_object('availabilityEnd', trim(updates ->> 'availabilityEnd')); end if;
        if coalesce(details ->> 'availabilityStart', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           or coalesce(details ->> 'availabilityEnd', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           or (details ->> 'availabilityEnd')::date < (details ->> 'availabilityStart')::date then
            raise exception 'Enter a valid availability start and end date.' using errcode = '22023';
        end if;
        if updates ? 'blockedDates' then
            if jsonb_typeof(updates -> 'blockedDates') <> 'array' then
                raise exception 'Blocked dates must be a list.' using errcode = '22023';
            end if;
            details := details || jsonb_build_object('blockedDates', updates -> 'blockedDates');
            perform * from public.get_short_term_blocked_date_entries(jsonb_build_object('realestate', details));
        end if;
        update public.short_term_listings set listing_payload = listing.listing_payload || jsonb_build_object('realestate', details)
        where id = listing.id returning * into listing;
    else raise exception 'Unsupported rental listing action.' using errcode = '22023';
    end if;
    return to_jsonb(listing);
end;
$$;
revoke all on function public.manage_my_rental_listing(text, text, text, jsonb) from public, anon;
grant execute on function public.manage_my_rental_listing(text, text, text, jsonb) to authenticated;

-- Applications become reviewable only after the proof upload has committed.
-- Existing submitted applications keep their current place in the review queue.
alter table public.host_applications add column if not exists ready_for_review boolean not null default true;

create or replace function public.prepare_host_application_draft()
returns trigger language plpgsql set search_path = public, auth, pg_temp as $$
begin
    if current_user in ('authenticated', 'anon') then
        if auth.uid() is null or new.user_id <> auth.uid() then
            raise exception 'Your own host application is required.' using errcode = '42501';
        end if;
        if tg_op = 'UPDATE' and old.ready_for_review and old.status in ('pending', 'approved') then
            raise exception 'This application is already under review or approved.' using errcode = '42501';
        end if;
        new.ready_for_review := false;
        new.status := 'pending';
        new.reviewed_at := null;
        new.reviewed_by := null;
        new.review_notes := null;
        new.submitted_at := now();
        new.email := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
        if new.email = '' then raise exception 'Account email is required.' using errcode = '22023'; end if;
    end if;
    return new;
end;
$$;
drop trigger if exists host_application_prepare_draft on public.host_applications;
create trigger host_application_prepare_draft before insert or update on public.host_applications
for each row execute function public.prepare_host_application_draft();

-- A user cannot attach another user's document or a path without an uploaded object.
drop policy if exists host_application_documents_insert_own on public.host_application_documents;
create policy host_application_documents_insert_own on public.host_application_documents for insert to authenticated
with check (
    auth.uid() = user_id
    and exists (select 1 from public.host_applications a where a.id = application_id and a.user_id = auth.uid() and not a.ready_for_review)
    and split_part(storage_path, '/', 1) = auth.uid()::text
    and split_part(storage_path, '/', 2) = application_id::text
    and exists (select 1 from storage.objects o where o.bucket_id = 'host-documents' and o.name = storage_path)
);
drop policy if exists host_application_documents_delete_own_or_admin on public.host_application_documents;
create policy host_application_documents_delete_own_or_admin on public.host_application_documents for delete to authenticated
using (public.is_admin_user() or (auth.uid() = user_id and exists (
    select 1 from public.host_applications a where a.id = application_id and a.user_id = auth.uid() and not a.ready_for_review
)));

create table if not exists public.rental_notification_outbox (
    id uuid primary key default gen_random_uuid(),
    application_id uuid not null references public.host_applications(id) on delete cascade,
    recipient_user_id uuid not null references auth.users(id) on delete cascade,
    recipient_role text not null check (recipient_role in ('host', 'admin')),
    event_type text not null check (event_type in ('submitted', 'approved', 'rejected', 'needs_more_info')),
    event_version timestamptz not null,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    last_error text,
    unique (application_id, recipient_user_id, event_type, event_version)
);
alter table public.rental_notification_outbox enable row level security;
revoke all on public.rental_notification_outbox from public, anon, authenticated;
grant select on public.rental_notification_outbox to authenticated;
grant all on public.rental_notification_outbox to service_role;
create policy rental_notification_recipient_select on public.rental_notification_outbox for select to authenticated
using (auth.uid() = recipient_user_id or public.is_admin_user());

create or replace function public.queue_host_application_notification()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
    event_name text;
    version_at timestamptz;
begin
    if not new.ready_for_review then return new; end if;
    if tg_op = 'UPDATE' and old.ready_for_review and old.status = new.status then return new; end if;
    event_name := case when new.status = 'pending' then 'submitted' else new.status end;
    version_at := case when new.status = 'pending' then new.submitted_at else new.reviewed_at end;
    insert into public.rental_notification_outbox(application_id, recipient_user_id, recipient_role, event_type, event_version)
    values(new.id, new.user_id, 'host', event_name, coalesce(version_at, now())) on conflict do nothing;
    if new.status = 'pending' then
        insert into public.rental_notification_outbox(application_id, recipient_user_id, recipient_role, event_type, event_version)
        select new.id, p.id, 'admin', event_name, coalesce(version_at, now()) from public.profiles p
        where p.is_admin and p.id <> new.user_id on conflict do nothing;
    end if;
    return new;
end;
$$;
revoke all on function public.queue_host_application_notification() from public, anon, authenticated;
create trigger host_application_notification after insert or update on public.host_applications
for each row execute function public.queue_host_application_notification();

create or replace function public.mark_my_host_application_pending()
returns public.profiles language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
    caller_id uuid := auth.uid();
    application public.host_applications%rowtype;
    result_row public.profiles%rowtype;
begin
    if caller_id is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
    select * into application from public.host_applications where user_id = caller_id for update;
    if not found or application.status <> 'pending' then
        raise exception 'A pending host application is required.' using errcode = '42501';
    end if;
    if not exists (select 1 from auth.users where id = caller_id and email_confirmed_at is not null) then
        raise exception 'Verified email required.' using errcode = '42501';
    end if;
    if not application.rules_acknowledged or nullif(trim(application.legal_name), '') is null
       or nullif(trim(application.phone), '') is null or nullif(trim(application.city), '') is null
       or nullif(trim(application.country), '') is null or nullif(trim(application.listing_city), '') is null
       or nullif(trim(application.property_type), '') is null or nullif(trim(application.hosting_experience), '') is null
       or nullif(trim(application.about_host), '') is null
       or coalesce(application.bedrooms, -1) < 0 or coalesce(application.bathrooms, 0) <= 0
       or coalesce(application.max_guest_capacity, 0) < 1 then
        raise exception 'Complete the host application before submitting.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.host_application_documents d join storage.objects o
        on o.bucket_id = 'host-documents' and o.name = d.storage_path
        where d.application_id = application.id and d.user_id = caller_id
          and d.document_type in ('government_id', 'property_proof', 'business_registration', 'other')
    ) then raise exception 'Upload an ID or property proof document before submitting.' using errcode = '22023'; end if;
    update public.host_applications set ready_for_review = true,
        submitted_at = case when ready_for_review then submitted_at else now() end,
        email = (select lower(trim(email)) from auth.users where id = caller_id)
    where id = application.id;
    update public.profiles set host_status = 'pending', host_email_verified = true,
        host_approved_at = null, host_rejected_at = null, host_review_notes = null, updated_at = now()
    where id = caller_id returning * into result_row;
    if not found then raise exception 'Applicant profile not found.' using errcode = '42501'; end if;
    return result_row;
end;
$$;
revoke all on function public.mark_my_host_application_pending() from public, anon;
grant execute on function public.mark_my_host_application_pending() to authenticated;

create or replace function public.review_host_application(p_application_id uuid, p_status text, p_review_notes text default null)
returns public.host_applications language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
    application public.host_applications%rowtype;
    next_status text := lower(trim(coalesce(p_status, '')));
    verified boolean;
begin
    if auth.uid() is null or not public.is_admin_user() then
        raise exception 'Administrator access required.' using errcode = '42501';
    end if;
    if next_status not in ('approved', 'rejected', 'needs_more_info') then
        raise exception 'Unsupported host review status.' using errcode = '22023';
    end if;
    select * into application from public.host_applications where id = p_application_id for update;
    if not found or not application.ready_for_review then
        raise exception 'A submitted application with uploaded proof is required.' using errcode = '22023';
    end if;
    if application.status = next_status then return application; end if;
    if application.status <> 'pending' then
        raise exception 'This application has already been reviewed. Refresh the admin inbox.' using errcode = '40001';
    end if;
    select email_confirmed_at is not null into verified from auth.users where id = application.user_id;
    if next_status = 'approved' and (not coalesce(verified, false) or not exists (
        select 1 from public.host_application_documents d join storage.objects o on o.bucket_id = 'host-documents' and o.name = d.storage_path
        where d.application_id = application.id and d.user_id = application.user_id
    )) then raise exception 'Verified email and uploaded proof are required for approval.' using errcode = '42501'; end if;
    update public.host_applications set status = next_status, reviewed_at = now(), reviewed_by = auth.uid(),
        review_notes = nullif(trim(p_review_notes), '') where id = application.id returning * into application;
    update public.profiles set host_status = next_status, host_email_verified = coalesce(verified, false),
        host_approved_at = case when next_status = 'approved' then now() else null end,
        host_rejected_at = case when next_status = 'rejected' then now() else null end,
        host_review_notes = application.review_notes, updated_at = now() where id = application.user_id;
    if not found then raise exception 'Applicant profile not found.' using errcode = '42501'; end if;
    return application;
end;
$$;
revoke all on function public.review_host_application(uuid, text, text) from public, anon;
grant execute on function public.review_host_application(uuid, text, text) to authenticated;

-- Serialize checkout creation, host capture, and cancellation for each stay.
alter table public.short_term_bookings
    add column if not exists payment_action_token uuid,
    add column if not exists payment_action_expires_at timestamptz;
create or replace function public.claim_short_term_payment_action(p_booking_public_id text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare token uuid := gen_random_uuid();
begin
    update public.short_term_bookings set payment_action_token = token, payment_action_expires_at = now() + interval '2 minutes'
    where public_id = p_booking_public_id
      and (guest_user_id = p_actor_id or host_user_id = p_actor_id or exists (select 1 from public.profiles where id = p_actor_id and is_admin))
      and (payment_action_token is null or payment_action_expires_at < now());
    if not found then raise exception 'Another payment action is in progress. Refresh and retry.' using errcode = '40001'; end if;
    return token;
end;
$$;
create or replace function public.release_short_term_payment_action(p_token uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
    update public.short_term_bookings set payment_action_token = null, payment_action_expires_at = null where payment_action_token = p_token;
$$;
revoke all on function public.claim_short_term_payment_action(text, uuid) from public, anon, authenticated;
revoke all on function public.release_short_term_payment_action(uuid) from public, anon, authenticated;
grant execute on function public.claim_short_term_payment_action(text, uuid) to service_role;
grant execute on function public.release_short_term_payment_action(uuid) to service_role;

-- Replayed webhooks must not erase refund state or downgrade captured money.
create or replace function public.guard_short_term_payment_transition()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
    if old.payment_status = 'refunded' and new.payment_status <> 'refunded' then return null; end if;
    if old.stripe_payment_intent_id is not distinct from new.stripe_payment_intent_id then
        if old.payment_status = 'paid' and new.payment_status in ('unpaid', 'requires_payment_method', 'authorized', 'processing', 'failed', 'cancelled') then return null; end if;
        if old.payment_status = 'authorized' and new.payment_status in ('unpaid', 'requires_payment_method', 'failed') then return null; end if;
    end if;
    new.payment_payload := coalesce(old.payment_payload, '{}'::jsonb) || coalesce(new.payment_payload, '{}'::jsonb);
    return new;
end;
$$;
create trigger short_term_payment_transition before update on public.short_term_bookings
for each row execute function public.guard_short_term_payment_transition();
