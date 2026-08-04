-- Production payment state is owned by Stripe webhooks and privileged Edge
-- Functions. Browser clients may read their own rows but cannot create or edit
-- billing, entitlement, or payout records directly.

create extension if not exists pgcrypto;

create table if not exists public.payment_entitlements (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    stripe_payment_intent_id text not null unique,
    placement text not null,
    request_id text,
    amount_cents bigint not null check (amount_cents >= 0),
    currency text not null,
    status text not null default 'pending' check (
        status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'refunded', 'disputed')
    ),
    livemode boolean not null default false,
    resource_type text,
    resource_id text,
    consumed_at timestamptz,
    paid_at timestamptz,
    refunded_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists payment_entitlements_user_created_idx
    on public.payment_entitlements (user_id, created_at desc);
create index if not exists payment_entitlements_status_idx
    on public.payment_entitlements (status, created_at desc);

drop trigger if exists payment_entitlements_set_updated_at on public.payment_entitlements;
create trigger payment_entitlements_set_updated_at
before update on public.payment_entitlements
for each row execute function public.set_updated_at();

alter table public.payment_entitlements enable row level security;
drop policy if exists "payment_entitlements_select_own" on public.payment_entitlements;
create policy "payment_entitlements_select_own"
on public.payment_entitlements
for select
to authenticated
using (auth.uid() = user_id or public.is_admin_user());
revoke all on table public.payment_entitlements from anon, authenticated;
grant select on table public.payment_entitlements to authenticated;

create table if not exists public.premium_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    stripe_customer_id text unique,
    stripe_subscription_id text unique,
    stripe_checkout_session_id text,
    plan_key text,
    status text not null default 'inactive',
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    livemode boolean not null default false,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists premium_subscriptions_customer_idx
    on public.premium_subscriptions (stripe_customer_id);
create index if not exists premium_subscriptions_status_idx
    on public.premium_subscriptions (status, current_period_end);

drop trigger if exists premium_subscriptions_set_updated_at on public.premium_subscriptions;
create trigger premium_subscriptions_set_updated_at
before update on public.premium_subscriptions
for each row execute function public.set_updated_at();

alter table public.premium_subscriptions enable row level security;
drop policy if exists "premium_subscriptions_select_own" on public.premium_subscriptions;
create policy "premium_subscriptions_select_own"
on public.premium_subscriptions
for select
to authenticated
using (auth.uid() = user_id or public.is_admin_user());
revoke all on table public.premium_subscriptions from anon, authenticated;
grant select on table public.premium_subscriptions to authenticated;

create table if not exists public.stripe_connected_accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references auth.users(id) on delete cascade,
    stripe_account_id text not null unique,
    account_type text not null default 'express',
    country text,
    charges_enabled boolean not null default false,
    payouts_enabled boolean not null default false,
    details_submitted boolean not null default false,
    onboarding_completed_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists stripe_connected_accounts_status_idx
    on public.stripe_connected_accounts (payouts_enabled, details_submitted);

drop trigger if exists stripe_connected_accounts_set_updated_at on public.stripe_connected_accounts;
create trigger stripe_connected_accounts_set_updated_at
before update on public.stripe_connected_accounts
for each row execute function public.set_updated_at();

alter table public.stripe_connected_accounts enable row level security;
drop policy if exists "stripe_connected_accounts_select_own" on public.stripe_connected_accounts;
create policy "stripe_connected_accounts_select_own"
on public.stripe_connected_accounts
for select
to authenticated
using (auth.uid() = user_id or public.is_admin_user());
revoke all on table public.stripe_connected_accounts from anon, authenticated;
grant select on table public.stripe_connected_accounts to authenticated;

alter table public.marketplace_listings
    add column if not exists promotion_payment_intent_id text,
    add column if not exists featured_until timestamptz;

alter table public.short_term_listings
    add column if not exists placement text not null default 'market',
    add column if not exists featured boolean not null default false,
    add column if not exists promotion_payment_intent_id text,
    add column if not exists featured_until timestamptz;

-- Direct listing updates remain blocked by the existing marketplace privilege
-- guard. This function consumes one paid entitlement and activates only a
-- listing owned by the caller.
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
