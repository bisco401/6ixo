-- Additive escrow checkout storage. Apply only this migration and its escrow-table prerequisite.
alter table public.escrow_transactions
  add column if not exists seller_user_id uuid references auth.users(id) on delete set null,
  add column if not exists request_id uuid,
  add column if not exists reference text,
  add column if not exists service_fee numeric not null default 0,
  add column if not exists fee_policy_version text,
  add column if not exists inspection_days integer not null default 3,
  add column if not exists listing_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists checkout_url text,
  add column if not exists provider_verified_at timestamptz;
create unique index if not exists escrow_checkout_request_idx on public.escrow_transactions(buyer_user_id,request_id) where request_id is not null;
create unique index if not exists escrow_checkout_reference_idx on public.escrow_transactions(reference) where reference is not null;
create index if not exists escrow_checkout_seller_idx on public.escrow_transactions(seller_user_id,created_at desc);
-- Hosted checkout tokens, provider payloads and private emails are exposed only through sanitized participant APIs.
revoke all on public.escrow_transactions from anon,authenticated;

create or replace function public.reserve_escrow_checkout(p_order jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare listing public.marketplace_listings%rowtype; existing public.escrow_transactions%rowtype; next_order public.escrow_transactions%rowtype;
begin
  select * into listing from public.marketplace_listings where public_id=p_order->>'listing_public_id' for update;
  if not found or listing.status <> 'published' then raise exception 'This listing is no longer available.'; end if;
  if listing.user_id=(p_order->>'buyer_user_id')::uuid or listing.user_id<>(p_order->>'seller_user_id')::uuid then raise exception 'The seller account does not match the listing.'; end if;
  if listing.price<>(p_order->>'amount')::numeric or lower(listing.currency)<>lower(p_order->>'listing_currency')
    or listing.listing_payload is distinct from p_order->'listing_snapshot'->'listing_payload'
    or listing.title is distinct from p_order->'listing_snapshot'->>'title'
    or listing.description is distinct from p_order->'listing_snapshot'->>'description'
    or listing.category is distinct from p_order->'listing_snapshot'->>'category'
    or listing.subcategory is distinct from p_order->'listing_snapshot'->>'subcategory'
    then raise exception 'This listing changed. Review a new quote before continuing.'; end if;
  select * into existing from public.escrow_transactions where buyer_user_id=(p_order->>'buyer_user_id')::uuid and request_id=(p_order->>'request_id')::uuid;
  if found then return jsonb_build_object('isNew',false,'order',to_jsonb(existing)); end if;
  if exists(select 1 from public.escrow_transactions where listing_public_id=listing.public_id and status not in ('cancelled','canceled','refunded','failed')) then
    raise exception 'This item already has an escrow transaction. Check My escrow deals or ask the seller to resolve it.';
  end if;
  insert into public.escrow_transactions(buyer_user_id,seller_user_id,listing_public_id,buyer_email,seller_email,amount,currency,status,request_id,reference,service_fee,fee_policy_version,inspection_days,listing_snapshot,request_payload)
  values((p_order->>'buyer_user_id')::uuid,listing.user_id,listing.public_id,p_order->>'buyer_email',p_order->>'seller_email',listing.price,p_order->>'currency','creating',(p_order->>'request_id')::uuid,p_order->>'reference',(p_order->>'service_fee')::numeric,p_order->>'fee_policy_version',3,p_order->'listing_snapshot',p_order->'request_payload') returning * into next_order;
  return jsonb_build_object('isNew',true,'order',to_jsonb(next_order));
end; $$;
revoke all on function public.reserve_escrow_checkout(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_escrow_checkout(jsonb) to service_role;

create or replace function public.lock_listing_during_escrow()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is not null and exists(select 1 from public.escrow_transactions where listing_public_id=old.public_id and status not in ('cancelled','canceled','refunded','failed')) then
    if tg_op='DELETE' or new.price is distinct from old.price or new.currency is distinct from old.currency
      or new.user_id is distinct from old.user_id or new.public_id is distinct from old.public_id
      or new.status is distinct from old.status or new.title is distinct from old.title
      or new.description is distinct from old.description or new.category is distinct from old.category
      or new.subcategory is distinct from old.subcategory or new.listing_payload is distinct from old.listing_payload then
      raise exception 'This listing has an escrow transaction. Resolve it on Escrow.com before changing or deleting the item.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end; $$;
drop trigger if exists marketplace_listing_escrow_lock on public.marketplace_listings;
create trigger marketplace_listing_escrow_lock before update or delete on public.marketplace_listings for each row execute function public.lock_listing_during_escrow();
