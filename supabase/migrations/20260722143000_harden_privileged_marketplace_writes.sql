-- Keep browser clients limited to ordinary profile fields. Host approval and
-- administrator state must only change through validated security-definer RPCs.
revoke insert, update on table public.profiles from authenticated;

grant insert (
    id,
    first_name,
    last_name,
    full_name,
    age,
    bio,
    phone,
    photo_url,
    interests,
    city,
    region,
    country,
    map_visible,
    updated_at
) on public.profiles to authenticated;

grant update (
    id,
    first_name,
    last_name,
    full_name,
    age,
    bio,
    phone,
    photo_url,
    interests,
    city,
    region,
    country,
    map_visible,
    updated_at
) on public.profiles to authenticated;

create or replace function public.mark_my_host_application_pending()
returns public.profiles
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    caller_id uuid := auth.uid();
    email_is_verified boolean := false;
    result_row public.profiles%rowtype;
begin
    if caller_id is null then
        raise exception 'Authentication required.' using errcode = '42501';
    end if;

    if not exists (
        select 1
        from public.host_applications application
        where application.user_id = caller_id
          and application.status = 'pending'
    ) then
        raise exception 'A pending host application is required.' using errcode = '42501';
    end if;

    select user_row.email_confirmed_at is not null
      into email_is_verified
      from auth.users user_row
     where user_row.id = caller_id;

    if coalesce(email_is_verified, false) = false then
        raise exception 'Verified email required.' using errcode = '42501';
    end if;

    update public.profiles
       set host_status = 'pending',
           host_email_verified = true,
           host_approved_at = null,
           host_rejected_at = null,
           host_review_notes = null,
           updated_at = now()
     where id = caller_id
     returning * into result_row;

    if not found then
        raise exception 'Profile not found.' using errcode = '42501';
    end if;

    return result_row;
end;
$$;

revoke all on function public.mark_my_host_application_pending() from public, anon;
grant execute on function public.mark_my_host_application_pending() to authenticated;

create or replace function public.review_host_application(
    p_application_id uuid,
    p_status text,
    p_review_notes text default null
)
returns public.host_applications
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    caller_id uuid := auth.uid();
    next_status text := lower(trim(coalesce(p_status, '')));
    review_notes_value text := nullif(trim(coalesce(p_review_notes, '')), '');
    reviewed_at_value timestamptz := now();
    application_row public.host_applications%rowtype;
    email_is_verified boolean := false;
begin
    if caller_id is null or public.is_admin_user() = false then
        raise exception 'Administrator access required.' using errcode = '42501';
    end if;

    if p_application_id is null
       or next_status not in ('approved', 'rejected', 'needs_more_info') then
        raise exception 'Unsupported host review status.' using errcode = '22023';
    end if;

    select *
      into application_row
      from public.host_applications
     where id = p_application_id
     for update;

    if not found then
        raise exception 'Host application not found.' using errcode = '22023';
    end if;

    update public.host_applications
       set status = next_status,
           reviewed_at = reviewed_at_value,
           reviewed_by = caller_id,
           review_notes = review_notes_value
     where id = application_row.id
     returning * into application_row;

    select user_row.email_confirmed_at is not null
      into email_is_verified
      from auth.users user_row
     where user_row.id = application_row.user_id;

    update public.profiles
       set host_status = next_status,
           host_email_verified = coalesce(email_is_verified, false),
           host_review_notes = review_notes_value,
           host_approved_at = case when next_status = 'approved' then reviewed_at_value else null end,
           host_rejected_at = case when next_status = 'rejected' then reviewed_at_value else null end,
           updated_at = reviewed_at_value
     where id = application_row.user_id;

    if not found then
        raise exception 'Applicant profile not found.' using errcode = '42501';
    end if;

    return application_row;
end;
$$;

revoke all on function public.review_host_application(uuid, text, text) from public, anon;
grant execute on function public.review_host_application(uuid, text, text) to authenticated;

-- Direct table writes may continue for ordinary marketplace listings, but
-- rental listings and paid featuring must pass through authoritative RPCs.
create or replace function public.guard_marketplace_listing_privileges()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    old_is_rental boolean := false;
    new_is_rental boolean := false;
begin
    new.listing_payload := coalesce(new.listing_payload, '{}'::jsonb) - 'hostEmail';

    new_is_rental := lower(coalesce(new.category, '')) = 'vehicles'
        and (
            lower(coalesce(new.subcategory, '')) = 'rentals'
            or lower(coalesce(new.listing_payload ->> 'category', '')) = 'rentals'
            or lower(coalesce(new.listing_payload ->> 'rentalMarket', '')) <> ''
            or lower(coalesce(new.listing_payload ->> 'isCustomVehicleListing', 'false')) in ('true', '1', 'yes', 'on')
        );

    if tg_op = 'UPDATE' then
        old_is_rental := lower(coalesce(old.category, '')) = 'vehicles'
            and (
                lower(coalesce(old.subcategory, '')) = 'rentals'
                or lower(coalesce(old.listing_payload ->> 'category', '')) = 'rentals'
                or lower(coalesce(old.listing_payload ->> 'rentalMarket', '')) <> ''
                or lower(coalesce(old.listing_payload ->> 'isCustomVehicleListing', 'false')) in ('true', '1', 'yes', 'on')
            );
    end if;

    if current_user in ('anon', 'authenticated') then
        if coalesce(new.featured, false) then
            raise exception 'Paid listing placement must use the promotion flow.' using errcode = '42501';
        end if;
        if old_is_rental or new_is_rental then
            raise exception 'Rental listings must use the approved-host listing flow.' using errcode = '42501';
        end if;
    end if;

    return new;
end;
$$;

revoke all on function public.guard_marketplace_listing_privileges() from public, anon, authenticated;

drop trigger if exists marketplace_listings_guard_privileged_writes on public.marketplace_listings;
create trigger marketplace_listings_guard_privileged_writes
before insert or update on public.marketplace_listings
for each row execute function public.guard_marketplace_listing_privileges();

-- Hosts must not be able to rewrite payment, totals, Stripe references, or
-- guest identity directly. Host actions already use the payment Edge Function.
drop policy if exists "vehicle_rental_bookings_participant_update" on public.vehicle_rental_bookings;
revoke update on table public.vehicle_rental_bookings from authenticated;

create or replace function public.canonicalize_vehicle_rental_booking_emails()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    canonical_email text;
begin
    if new.guest_user_id is not null then
        select lower(trim(coalesce(user_row.email, '')))
          into canonical_email
          from auth.users user_row
         where user_row.id = new.guest_user_id;
        if coalesce(canonical_email, '') = '' then
            raise exception 'Guest account email is required.' using errcode = '22023';
        end if;
        new.guest_email := canonical_email;
    end if;

    if new.host_user_id is not null then
        select lower(trim(coalesce(user_row.email, '')))
          into canonical_email
          from auth.users user_row
         where user_row.id = new.host_user_id;
        if coalesce(canonical_email, '') <> '' then
            new.host_email := canonical_email;
        end if;
    end if;

    return new;
end;
$$;

revoke all on function public.canonicalize_vehicle_rental_booking_emails() from public, anon, authenticated;

drop trigger if exists vehicle_rental_bookings_canonicalize_emails on public.vehicle_rental_bookings;
create trigger vehicle_rental_bookings_canonicalize_emails
before insert or update on public.vehicle_rental_bookings
for each row execute function public.canonicalize_vehicle_rental_booking_emails();
