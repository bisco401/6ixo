-- Vehicle rental operators have different legal, insurance, and safety
-- requirements from short-term property hosts. Keep both approval paths
-- independent all the way through the authoritative listing gates.

alter table public.profiles
    add column if not exists vehicle_host_status text not null default 'none',
    add column if not exists vehicle_host_email_verified boolean not null default false,
    add column if not exists vehicle_host_approved_at timestamptz,
    add column if not exists vehicle_host_rejected_at timestamptz,
    add column if not exists vehicle_host_review_notes text;

alter table public.profiles
    drop constraint if exists profiles_vehicle_host_status_check;
alter table public.profiles
    add constraint profiles_vehicle_host_status_check
    check (vehicle_host_status in ('none', 'pending', 'approved', 'rejected', 'needs_more_info'));

create table if not exists public.vehicle_host_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    email text not null,
    legal_name text not null,
    phone text not null,
    city text not null,
    country text not null,
    applicant_type text not null,
    business_name text,
    rental_city text not null,
    fleet_size integer not null,
    years_renting integer not null,
    owns_vehicles boolean not null,
    has_rental_authorization boolean not null,
    has_valid_driver_license boolean not null,
    vehicles_registered boolean not null,
    has_rental_insurance boolean not null,
    insurance_provider text not null,
    insurance_policy_number text not null,
    vehicles_roadworthy boolean not null,
    has_maintenance_plan boolean not null,
    has_roadside_support boolean not null,
    complies_local_laws boolean not null,
    rented_before boolean not null,
    rental_experience text not null,
    suspended_elsewhere boolean not null,
    suspension_explanation text,
    has_relevant_conviction boolean not null,
    conviction_explanation text,
    agrees_vehicle_safety boolean not null,
    agrees_renter_verification boolean not null,
    agrees_truthful_listing boolean not null,
    rules_acknowledged boolean not null default false,
    status text not null default 'pending',
    submitted_at timestamptz not null default timezone('utc', now()),
    reviewed_at timestamptz,
    reviewed_by uuid references auth.users(id) on delete set null,
    review_notes text,
    unique (user_id),
    constraint vehicle_host_applications_type_check check (applicant_type in ('individual', 'business', 'fleet')),
    constraint vehicle_host_applications_fleet_size_check check (fleet_size > 0),
    constraint vehicle_host_applications_years_check check (years_renting >= 0),
    constraint vehicle_host_applications_status_check check (status in ('pending', 'approved', 'rejected', 'needs_more_info'))
);

create index if not exists vehicle_host_applications_status_idx
    on public.vehicle_host_applications (status, submitted_at desc);

alter table public.vehicle_host_applications enable row level security;

drop policy if exists "vehicle_host_applications_select_own_or_admin" on public.vehicle_host_applications;
create policy "vehicle_host_applications_select_own_or_admin"
    on public.vehicle_host_applications for select to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "vehicle_host_applications_insert_own" on public.vehicle_host_applications;
create policy "vehicle_host_applications_insert_own"
    on public.vehicle_host_applications for insert to authenticated
    with check (auth.uid() = user_id and status = 'pending');

drop policy if exists "vehicle_host_applications_update_own_pending" on public.vehicle_host_applications;
create policy "vehicle_host_applications_update_own_pending"
    on public.vehicle_host_applications for update to authenticated
    using (auth.uid() = user_id and status in ('pending', 'rejected', 'needs_more_info'))
    with check (auth.uid() = user_id and status = 'pending');

drop policy if exists "vehicle_host_applications_update_admin" on public.vehicle_host_applications;
create policy "vehicle_host_applications_update_admin"
    on public.vehicle_host_applications for update to authenticated
    using (public.is_admin_user())
    with check (public.is_admin_user());

grant select, insert, update on public.vehicle_host_applications to authenticated;

create table if not exists public.vehicle_host_application_documents (
    id uuid primary key default gen_random_uuid(),
    application_id uuid not null references public.vehicle_host_applications(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    document_type text not null,
    file_name text not null,
    storage_path text not null unique,
    mime_type text,
    size_bytes bigint,
    created_at timestamptz not null default timezone('utc', now()),
    constraint vehicle_host_application_documents_type_check
        check (document_type in ('vehicle_driver_license', 'vehicle_registration', 'vehicle_rental_insurance'))
);

create index if not exists vehicle_host_application_documents_application_idx
    on public.vehicle_host_application_documents (application_id, created_at desc);

alter table public.vehicle_host_application_documents enable row level security;

drop policy if exists "vehicle_host_application_documents_select_own_or_admin" on public.vehicle_host_application_documents;
create policy "vehicle_host_application_documents_select_own_or_admin"
    on public.vehicle_host_application_documents for select to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

drop policy if exists "vehicle_host_application_documents_insert_own" on public.vehicle_host_application_documents;
create policy "vehicle_host_application_documents_insert_own"
    on public.vehicle_host_application_documents for insert to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1 from public.vehicle_host_applications application
            where application.id = vehicle_host_application_documents.application_id
              and application.user_id = auth.uid()
        )
    );

drop policy if exists "vehicle_host_application_documents_delete_own_or_admin" on public.vehicle_host_application_documents;
create policy "vehicle_host_application_documents_delete_own_or_admin"
    on public.vehicle_host_application_documents for delete to authenticated
    using (auth.uid() = user_id or public.is_admin_user());

grant select, insert, delete on public.vehicle_host_application_documents to authenticated;

create or replace function public.mark_my_vehicle_host_application_pending()
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
        select 1 from public.vehicle_host_applications application
        where application.user_id = caller_id and application.status = 'pending'
    ) then
        raise exception 'A pending car rental application is required.' using errcode = '42501';
    end if;
    select user_row.email_confirmed_at is not null
      into email_is_verified
      from auth.users user_row
     where user_row.id = caller_id;
    if coalesce(email_is_verified, false) = false then
        raise exception 'Verified email required.' using errcode = '42501';
    end if;
    update public.profiles
       set vehicle_host_status = 'pending',
           vehicle_host_email_verified = true,
           vehicle_host_approved_at = null,
           vehicle_host_rejected_at = null,
           vehicle_host_review_notes = null,
           updated_at = now()
     where id = caller_id
     returning * into result_row;
    if not found then raise exception 'Profile not found.' using errcode = '42501'; end if;
    return result_row;
end;
$$;

revoke all on function public.mark_my_vehicle_host_application_pending() from public, anon;
grant execute on function public.mark_my_vehicle_host_application_pending() to authenticated;

create or replace function public.review_vehicle_host_application(
    p_application_id uuid,
    p_status text,
    p_review_notes text default null
)
returns public.vehicle_host_applications
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    caller_id uuid := auth.uid();
    next_status text := lower(trim(coalesce(p_status, '')));
    review_notes_value text := nullif(trim(coalesce(p_review_notes, '')), '');
    reviewed_at_value timestamptz := now();
    application_row public.vehicle_host_applications%rowtype;
    email_is_verified boolean := false;
begin
    if caller_id is null or public.is_admin_user() = false then
        raise exception 'Administrator access required.' using errcode = '42501';
    end if;
    if p_application_id is null or next_status not in ('approved', 'rejected', 'needs_more_info') then
        raise exception 'Unsupported car rental review status.' using errcode = '22023';
    end if;
    select * into application_row
      from public.vehicle_host_applications
     where id = p_application_id
     for update;
    if not found then raise exception 'Car rental application not found.' using errcode = '22023'; end if;

    if next_status = 'approved' and exists (
        select 1
          from unnest(array['vehicle_driver_license', 'vehicle_registration', 'vehicle_rental_insurance']::text[]) required(document_type)
         where not exists (
             select 1 from public.vehicle_host_application_documents document
             where document.application_id = application_row.id
               and document.user_id = application_row.user_id
               and lower(trim(document.document_type)) = required.document_type
         )
    ) then
        raise exception 'All three required vehicle documents must be uploaded before approval.' using errcode = '22023';
    end if;

    update public.vehicle_host_applications
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
       set vehicle_host_status = next_status,
           vehicle_host_email_verified = coalesce(email_is_verified, false),
           vehicle_host_review_notes = review_notes_value,
           vehicle_host_approved_at = case when next_status = 'approved' then reviewed_at_value else null end,
           vehicle_host_rejected_at = case when next_status = 'rejected' then reviewed_at_value else null end,
           updated_at = reviewed_at_value
     where id = application_row.user_id;
    if not found then raise exception 'Applicant profile not found.' using errcode = '42501'; end if;
    return application_row;
end;
$$;

revoke all on function public.review_vehicle_host_application(uuid, text, text) from public, anon;
grant execute on function public.review_vehicle_host_application(uuid, text, text) to authenticated;

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
        'currency', listing_currency, 'status', 'published',
        'vehicleHostApplicationId', approved_application_id::text
    );
    insert into public.marketplace_listings (
        user_id, marketplace_profile_id, category, subcategory, title, description,
        price, currency, city, country, status, placement, featured, media_urls,
        primary_media_url, listing_payload
    ) values (
        caller_id, marketplace_profile_ref, 'vehicles', 'rentals', listing_title,
        listing_description, listing_price, listing_currency, listing_city,
        listing_country, 'published', 'market', false, media_urls,
        nullif(coalesce(media_urls[1], ''), ''), authoritative_payload
    ) returning * into result_row;
    return result_row;
end;
$$;

revoke all on function public.create_vehicle_rental_listing(jsonb) from public, anon;
grant execute on function public.create_vehicle_rental_listing(jsonb) to authenticated;

create or replace function public.enforce_vehicle_rental_compliance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    approved_application_id uuid;
begin
    if lower(coalesce(new.category, '')) = 'vehicles'
       and lower(coalesce(new.subcategory, '')) = 'rentals'
       and lower(coalesce(new.status, '')) = 'published' then
        select application.id into approved_application_id
          from public.vehicle_host_applications application
         where application.user_id = new.user_id and application.status = 'approved'
         order by application.reviewed_at desc nulls last, application.submitted_at desc
         limit 1;
        if approved_application_id is null then raise exception 'Approved car rental application is required for vehicle rentals.' using errcode = '42501'; end if;
        if exists (
            select 1
              from unnest(array['vehicle_driver_license', 'vehicle_registration', 'vehicle_rental_insurance']::text[]) required(document_type)
             where not exists (
                 select 1 from public.vehicle_host_application_documents document
                  where document.application_id = approved_application_id
                    and document.user_id = new.user_id
                    and lower(trim(document.document_type)) = required.document_type
             )
        ) then
            raise exception 'Driver licence, vehicle registration, and rental-use insurance evidence are required.' using errcode = '42501';
        end if;
    end if;
    return new;
end;
$$;

revoke all on function public.enforce_vehicle_rental_compliance() from public, anon, authenticated;

drop trigger if exists marketplace_listings_enforce_vehicle_rental_compliance on public.marketplace_listings;
create trigger marketplace_listings_enforce_vehicle_rental_compliance
before insert or update of status on public.marketplace_listings
for each row execute function public.enforce_vehicle_rental_compliance();
