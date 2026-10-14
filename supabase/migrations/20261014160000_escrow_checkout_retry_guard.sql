-- Bind retry request IDs to their original listing.
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
  if found then
    if existing.listing_public_id<>listing.public_id then raise exception 'This checkout request belongs to another item.'; end if;
    return jsonb_build_object('isNew',false,'order',to_jsonb(existing));
  end if;
  if exists(select 1 from public.escrow_transactions where listing_public_id=listing.public_id and status not in ('cancelled','canceled','refunded','failed')) then
    raise exception 'This item already has an escrow transaction. Check My escrow deals or ask the seller to resolve it.';
  end if;
  insert into public.escrow_transactions(buyer_user_id,seller_user_id,listing_public_id,buyer_email,seller_email,amount,currency,status,request_id,reference,service_fee,fee_policy_version,inspection_days,listing_snapshot,request_payload)
  values((p_order->>'buyer_user_id')::uuid,listing.user_id,listing.public_id,p_order->>'buyer_email',p_order->>'seller_email',listing.price,p_order->>'currency','creating',(p_order->>'request_id')::uuid,p_order->>'reference',(p_order->>'service_fee')::numeric,p_order->>'fee_policy_version',3,p_order->'listing_snapshot',p_order->'request_payload') returning * into next_order;
  return jsonb_build_object('isNew',true,'order',to_jsonb(next_order));
end; $$;
