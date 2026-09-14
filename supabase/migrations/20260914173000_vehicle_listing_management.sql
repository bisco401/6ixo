create or replace function public.get_my_rental_listings()
returns table(listing_type text,public_id text,title text,city text,country text,status text,listing_payload jsonb,updated_at timestamptz)
language sql security definer set search_path=public,pg_temp stable as $$
 select 'short_term'::text,l.public_id,l.title,l.city,l.country,l.status,l.listing_payload,l.updated_at from short_term_listings l where l.user_id=auth.uid()
 union all
 select 'vehicle_rental'::text,l.public_id,l.title,l.city,l.country,l.status,l.listing_payload,l.updated_at from marketplace_listings l where l.user_id=auth.uid() and l.category='vehicles' and l.subcategory='rentals'
 order by updated_at desc;
$$;
revoke all on function public.get_my_rental_listings() from public,anon;grant execute on function public.get_my_rental_listings() to authenticated;
create or replace function public.manage_my_vehicle_rental_listing(p_listing_public_id text,p_action text,p_updates jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.marketplace_listings; next_status text;details jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501';end if;
 select * into l from marketplace_listings where public_id=p_listing_public_id and user_id=auth.uid() and category='vehicles' and subcategory='rentals' for update;
 if not found then raise exception 'Owned vehicle rental required.' using errcode='42501';end if;
 if p_action in ('publish','pause','archive') then
 next_status:=case p_action when 'publish' then 'published' when 'pause' then 'paused' else 'archived' end;
 update marketplace_listings set status=next_status,listing_payload=l.listing_payload||jsonb_build_object('status',next_status) where id=l.id returning * into l;
 elsif p_action='update_availability' then
 details:=l.listing_payload;
 if p_updates ? 'blockedDates' then
 if jsonb_typeof(p_updates->'blockedDates') is distinct from 'array' then raise exception 'Blocked dates must be a list.';end if;
 details:=details||jsonb_build_object('blockedDates',p_updates->'blockedDates');perform * from get_vehicle_rental_blocked_date_entries(details);
 end if;
 if p_updates ? 'availabilityStart' then details:=details||jsonb_build_object('availabilityStart',p_updates->>'availabilityStart');end if;
 if p_updates ? 'availabilityEnd' then details:=details||jsonb_build_object('availabilityEnd',p_updates->>'availabilityEnd');end if;
 if nullif(details->>'availabilityStart','')::date> nullif(details->>'availabilityEnd','')::date then raise exception 'Availability end must follow its start.';end if;
 update marketplace_listings set listing_payload=details where id=l.id returning * into l;
 elsif p_action='update_price' then
 if coalesce((p_updates->>'dailyRate')::numeric,0)<=0 then raise exception 'Daily rate must be positive.';end if;
 update marketplace_listings set price=(p_updates->>'dailyRate')::numeric,listing_payload=l.listing_payload||jsonb_build_object('dailyRate',(p_updates->>'dailyRate')::numeric,'priceValue',(p_updates->>'dailyRate')::numeric) where id=l.id returning * into l;
 else raise exception 'Unsupported vehicle listing action.';end if;
 return to_jsonb(l);
end $$;
revoke all on function public.manage_my_vehicle_rental_listing(text,text,jsonb) from public,anon;grant execute on function public.manage_my_vehicle_rental_listing(text,text,jsonb) to authenticated;
