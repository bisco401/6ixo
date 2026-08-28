-- Add a durable paid placement for the homepage Today's Deals row.
-- Payment entitlement verification remains authoritative; the browser cannot
-- set featured listing state directly.

create or replace function public.activate_paid_listing_promotion(
    p_listing_type text,
    p_listing_public_id text,
    p_payment_intent_id text,
    p_placement text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    caller_id uuid := auth.uid();
    listing_type_value text := lower(trim(coalesce(p_listing_type, '')));
    listing_ref text := trim(coalesce(p_listing_public_id, ''));
    payment_ref text := trim(coalesce(p_payment_intent_id, ''));
    placement_value text := lower(trim(coalesce(p_placement, '')));
    entitlement_row public.payment_entitlements%rowtype;
    featured_expiry timestamptz;
    affected_rows integer := 0;
begin
    if caller_id is null then
        raise exception 'Authentication required.' using errcode = '42501';
    end if;
    if listing_ref = '' or payment_ref = '' or placement_value = '' then
        raise exception 'Listing, payment, and placement are required.' using errcode = '22023';
    end if;

    select *
      into entitlement_row
      from public.payment_entitlements
     where stripe_payment_intent_id = payment_ref
       and user_id = caller_id
     for update;

    if not found or entitlement_row.status <> 'paid' then
        raise exception 'A completed payment is required.' using errcode = '42501';
    end if;
    if entitlement_row.placement <> placement_value then
        raise exception 'Payment placement does not match.' using errcode = '42501';
    end if;
    if entitlement_row.consumed_at is not null
       and (entitlement_row.resource_type <> listing_type_value or entitlement_row.resource_id <> listing_ref) then
        raise exception 'This payment has already been used.' using errcode = '23505';
    end if;

    featured_expiry := timezone('utc', now()) + case
        when placement_value = 'dating_featured' then interval '48 hours'
        when placement_value = 'companionship_featured' then interval '1 day'
        else interval '7 days'
    end;

    if listing_type_value = 'marketplace_listing' then
        update public.marketplace_listings
           set featured = true,
               placement = case
                   when placement_value = 'community_featured' then 'community'
                   when placement_value = 'today_deals_featured' then 'today_deals_featured'
                   else 'market'
               end,
               promotion_payment_intent_id = payment_ref,
               featured_until = featured_expiry,
               updated_at = timezone('utc', now())
         where public_id = listing_ref
           and user_id = caller_id;
        get diagnostics affected_rows = row_count;
    elsif listing_type_value = 'short_term_listing' then
        update public.short_term_listings
           set featured = true,
               placement = 'market',
               promotion_payment_intent_id = payment_ref,
               featured_until = featured_expiry,
               updated_at = timezone('utc', now())
         where public_id = listing_ref
           and user_id = caller_id;
        get diagnostics affected_rows = row_count;
    else
        raise exception 'Unsupported paid listing type.' using errcode = '22023';
    end if;

    if affected_rows <> 1 then
        raise exception 'Owned listing not found.' using errcode = 'P0002';
    end if;

    update public.payment_entitlements
       set resource_type = listing_type_value,
           resource_id = listing_ref,
           consumed_at = coalesce(consumed_at, timezone('utc', now())),
           updated_at = timezone('utc', now())
     where id = entitlement_row.id;

    return jsonb_build_object(
        'ok', true,
        'listingType', listing_type_value,
        'listingPublicId', listing_ref,
        'placement', placement_value,
        'featuredUntil', featured_expiry
    );
end;
$$;

revoke all on function public.activate_paid_listing_promotion(text, text, text, text) from public, anon;
grant execute on function public.activate_paid_listing_promotion(text, text, text, text) to authenticated;
