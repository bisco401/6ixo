-- Refunds and disputes must survive stale verifications and delayed webhooks.
create or replace function public.guard_payment_entitlement_state()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
    if tg_op = 'UPDATE' then
        if old.status = 'refunded' then
            new.status := 'refunded';
        elsif old.status = 'disputed' and new.status <> 'refunded' then
            new.status := 'disputed';
        end if;
        new.paid_at := coalesce(old.paid_at, new.paid_at);
        new.refunded_at := coalesce(old.refunded_at, new.refunded_at);
    end if;
    if new.status = 'refunded' then
        new.refunded_at := coalesce(new.refunded_at, now());
    end if;
    return new;
end;
$$;

create trigger payment_entitlements_guard_state
before insert or update on public.payment_entitlements
for each row execute function public.guard_payment_entitlement_state();

create or replace function public.revoke_unpaid_promotion_delivery()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
    if new.status in ('refunded', 'disputed') then
        update public.marketplace_listings set featured = false, featured_until = null
        where promotion_payment_intent_id = new.stripe_payment_intent_id;
        update public.short_term_listings set featured = false, featured_until = null
        where promotion_payment_intent_id = new.stripe_payment_intent_id;
        update public.ad_campaigns
        set status = case when new.status = 'refunded' then 'refunded' else 'paused' end
        where stripe_payment_intent_id = new.stripe_payment_intent_id;
    end if;
    return new;
end;
$$;

create trigger payment_entitlements_revoke_delivery
after insert or update on public.payment_entitlements
for each row execute function public.revoke_unpaid_promotion_delivery();

create or replace function public.guard_paid_campaign_delivery()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare payment_status text;
begin
    if new.stripe_payment_intent_id is not null and new.status = 'active' then
        select status into payment_status from public.payment_entitlements
        where stripe_payment_intent_id = new.stripe_payment_intent_id for share;
        if payment_status is distinct from 'paid' then
            new.status := case when payment_status = 'refunded' then 'refunded' else 'paused' end;
        end if;
    end if;
    return new;
end;
$$;

create trigger ad_campaigns_guard_paid_delivery
before insert or update on public.ad_campaigns
for each row execute function public.guard_paid_campaign_delivery();

revoke all on function public.guard_payment_entitlement_state() from public;
revoke all on function public.revoke_unpaid_promotion_delivery() from public;
revoke all on function public.guard_paid_campaign_delivery() from public;

-- Repair delivery for any already-recorded refunds or disputes.
update public.payment_entitlements set status = status where status in ('refunded', 'disputed');
