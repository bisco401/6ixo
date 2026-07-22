-- Replace the listing RPC with explicit text[] casts for empty media sets.

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
    media_urls text[] := '{}'::text[];
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
        select coalesce(array_agg(trim(media.value)) filter (where trim(media.value) <> ''), '{}'::text[])
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
