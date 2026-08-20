-- Seller subscriptions and measurable paid advertising.
-- Stripe/webhook code owns billing state. Browser clients can read their own
-- records and record validated campaign events through the RPC below.

create extension if not exists pgcrypto;

create table if not exists public.seller_subscriptions (
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

create index if not exists seller_subscriptions_customer_idx
    on public.seller_subscriptions (stripe_customer_id);
create index if not exists seller_subscriptions_status_idx
    on public.seller_subscriptions (status, current_period_end);

drop trigger if exists seller_subscriptions_set_updated_at on public.seller_subscriptions;
create trigger seller_subscriptions_set_updated_at
before update on public.seller_subscriptions
for each row execute function public.set_updated_at();

alter table public.seller_subscriptions enable row level security;
drop policy if exists "seller_subscriptions_select_own" on public.seller_subscriptions;
create policy "seller_subscriptions_select_own"
on public.seller_subscriptions
for select
to authenticated
using (auth.uid() = user_id or public.is_admin_user());
revoke all on table public.seller_subscriptions from anon, authenticated;
grant select on table public.seller_subscriptions to authenticated;

create table if not exists public.ad_campaigns (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null references auth.users(id) on delete cascade,
    payment_entitlement_id uuid references public.payment_entitlements(id) on delete set null,
    stripe_payment_intent_id text unique,
    name text not null,
    placement text not null,
    campaign_kind text not null default 'featured_listing' check (
        campaign_kind in ('featured_listing', 'banner', 'feed_boost', 'sponsored_profile')
    ),
    status text not null default 'scheduled' check (
        status in ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled', 'refunded')
    ),
    resource_type text,
    resource_id text,
    creative_title text,
    creative_image_url text,
    destination_url text,
    target_country text,
    target_region text,
    target_city text,
    target_category text,
    amount_cents bigint not null default 0 check (amount_cents >= 0),
    currency text not null default 'USD',
    starts_at timestamptz not null default timezone('utc', now()),
    ends_at timestamptz not null,
    impression_count bigint not null default 0 check (impression_count >= 0),
    click_count bigint not null default 0 check (click_count >= 0),
    lead_count bigint not null default 0 check (lead_count >= 0),
    checkout_count bigint not null default 0 check (checkout_count >= 0),
    purchase_count bigint not null default 0 check (purchase_count >= 0),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now()),
    check (ends_at > starts_at)
);

create index if not exists ad_campaigns_owner_created_idx
    on public.ad_campaigns (owner_user_id, created_at desc);
create index if not exists ad_campaigns_delivery_idx
    on public.ad_campaigns (status, placement, starts_at, ends_at);
create index if not exists ad_campaigns_targeting_idx
    on public.ad_campaigns (target_country, target_region, target_city, target_category);

drop trigger if exists ad_campaigns_set_updated_at on public.ad_campaigns;
create trigger ad_campaigns_set_updated_at
before update on public.ad_campaigns
for each row execute function public.set_updated_at();

alter table public.ad_campaigns enable row level security;
drop policy if exists "ad_campaigns_select_own_or_active" on public.ad_campaigns;
drop policy if exists "ad_campaigns_select_own" on public.ad_campaigns;
create policy "ad_campaigns_select_own"
on public.ad_campaigns
for select
to authenticated
using (auth.uid() = owner_user_id or public.is_admin_user());
revoke all on table public.ad_campaigns from anon, authenticated;
grant select on table public.ad_campaigns to authenticated;

create or replace function public.get_active_ad_campaigns_for_delivery(
    p_country text default null,
    p_region text default null,
    p_city text default null,
    p_category text default null
)
returns table (
    id uuid,
    name text,
    placement text,
    resource_type text,
    resource_id text,
    target_country text,
    target_region text,
    target_city text,
    target_category text,
    starts_at timestamptz,
    ends_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select
        c.id, c.name, c.placement, c.resource_type, c.resource_id,
        c.target_country, c.target_region, c.target_city, c.target_category,
        c.starts_at, c.ends_at
    from public.ad_campaigns c
    where c.status = 'active'
      and c.starts_at <= timezone('utc', now())
      and c.ends_at > timezone('utc', now())
      and (nullif(trim(c.target_country), '') is null or lower(trim(c.target_country)) = lower(trim(coalesce(p_country, ''))))
      and (nullif(trim(c.target_region), '') is null or lower(trim(c.target_region)) = lower(trim(coalesce(p_region, ''))))
      and (nullif(trim(c.target_city), '') is null or lower(trim(c.target_city)) = lower(trim(coalesce(p_city, ''))))
      and (
          nullif(trim(c.target_category), '') is null
          or nullif(trim(coalesce(p_category, '')), '') is null
          or lower(trim(c.target_category)) = lower(trim(p_category))
      )
    order by c.created_at desc
    limit 100;
$$;

revoke all on function public.get_active_ad_campaigns_for_delivery(text, text, text, text) from public;
grant execute on function public.get_active_ad_campaigns_for_delivery(text, text, text, text) to anon, authenticated;

create table if not exists public.ad_campaign_events (
    id bigint generated always as identity primary key,
    campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
    event_type text not null check (
        event_type in ('impression', 'click', 'lead', 'checkout', 'purchase')
    ),
    placement text,
    session_key text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now())
);

create index if not exists ad_campaign_events_campaign_created_idx
    on public.ad_campaign_events (campaign_id, created_at desc);
create index if not exists ad_campaign_events_type_created_idx
    on public.ad_campaign_events (event_type, created_at desc);

alter table public.ad_campaign_events enable row level security;
drop policy if exists "ad_campaign_events_select_campaign_owner" on public.ad_campaign_events;
create policy "ad_campaign_events_select_campaign_owner"
on public.ad_campaign_events
for select
to authenticated
using (
    exists (
        select 1
        from public.ad_campaigns campaign
        where campaign.id = campaign_id
          and (campaign.owner_user_id = auth.uid() or public.is_admin_user())
    )
);
revoke all on table public.ad_campaign_events from anon, authenticated;
grant select on table public.ad_campaign_events to authenticated;

create or replace function public.record_ad_campaign_event(
    p_campaign_id uuid,
    p_event_type text,
    p_placement text default null,
    p_session_key text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    event_value text := lower(trim(coalesce(p_event_type, '')));
    session_value text := left(trim(coalesce(p_session_key, '')), 120);
    campaign_row public.ad_campaigns%rowtype;
    was_recorded boolean := false;
begin
    if event_value not in ('impression', 'click', 'lead') then
        raise exception 'Unsupported campaign event.';
    end if;

    select * into campaign_row
    from public.ad_campaigns
    where id = p_campaign_id
      and status = 'active'
      and starts_at <= timezone('utc', now())
      and ends_at > timezone('utc', now());

    if not found then
        return jsonb_build_object('ok', false, 'reason', 'campaign_inactive');
    end if;

    -- One impression per browser session prevents scroll/render loops from
    -- inflating advertiser totals while still allowing privacy-safe analytics.
    if event_value = 'impression' and session_value <> '' and exists (
        select 1 from public.ad_campaign_events
        where campaign_id = p_campaign_id
          and event_type = 'impression'
          and session_key = session_value
    ) then
        return jsonb_build_object('ok', true, 'recorded', false, 'reason', 'duplicate_impression');
    end if;

    insert into public.ad_campaign_events (campaign_id, event_type, placement, session_key, metadata)
    values (
        p_campaign_id,
        event_value,
        left(trim(coalesce(p_placement, campaign_row.placement)), 80),
        nullif(session_value, ''),
        coalesce(p_metadata, '{}'::jsonb)
    );
    was_recorded := true;

    update public.ad_campaigns
    set impression_count = impression_count + case when event_value = 'impression' then 1 else 0 end,
        click_count = click_count + case when event_value = 'click' then 1 else 0 end,
        lead_count = lead_count + case when event_value = 'lead' then 1 else 0 end,
        checkout_count = checkout_count + case when event_value = 'checkout' then 1 else 0 end,
        purchase_count = purchase_count + case when event_value = 'purchase' then 1 else 0 end
    where id = p_campaign_id;

    return jsonb_build_object('ok', true, 'recorded', was_recorded);
end;
$$;

revoke all on function public.record_ad_campaign_event(uuid, text, text, text, jsonb) from public;
grant execute on function public.record_ad_campaign_event(uuid, text, text, text, jsonb) to anon, authenticated;

create or replace function public.get_advertiser_campaign_summary()
returns table (
    campaign_id uuid,
    campaign_name text,
    placement text,
    campaign_status text,
    starts_at timestamptz,
    ends_at timestamptz,
    amount_cents bigint,
    currency text,
    impressions bigint,
    clicks bigint,
    leads bigint,
    checkouts bigint,
    purchases bigint,
    click_through_rate numeric
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select
        c.id,
        c.name,
        c.placement,
        case
            when c.status = 'active' and c.ends_at <= timezone('utc', now()) then 'completed'
            else c.status
        end,
        c.starts_at,
        c.ends_at,
        c.amount_cents,
        c.currency,
        c.impression_count,
        c.click_count,
        c.lead_count,
        c.checkout_count,
        c.purchase_count,
        case
            when c.impression_count > 0
                then round((c.click_count::numeric / c.impression_count::numeric) * 100, 2)
            else 0
        end
    from public.ad_campaigns c
    where c.owner_user_id = auth.uid() or public.is_admin_user()
    order by c.created_at desc;
$$;

revoke all on function public.get_advertiser_campaign_summary() from public;
grant execute on function public.get_advertiser_campaign_summary() to authenticated;

comment on table public.ad_campaigns is 'Paid placement lifecycle, targeting, creative, and aggregate performance.';
comment on table public.ad_campaign_events is 'Privacy-safe paid campaign delivery and conversion events.';
