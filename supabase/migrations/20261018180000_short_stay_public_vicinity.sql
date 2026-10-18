-- Keep hosts' private address data intact. Public stays expose a coarse area
-- through the ready-listings RPC; raw rows remain owner/admin only.
create or replace function public.short_stay_public_payload(payload jsonb, area_label text)
returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare result jsonb; item record; normalized_key text; coordinate numeric;
begin
 if jsonb_typeof(payload)='array' then
  select coalesce(jsonb_agg(public.short_stay_public_payload(value,area_label) order by ordinality),'[]'::jsonb)
   into result from jsonb_array_elements(payload) with ordinality;
  return result;
 elsif jsonb_typeof(payload)<>'object' or payload is null then
  return payload;
 end if;
 result:='{}'::jsonb;
 for item in select key,value from jsonb_each(payload) loop
  normalized_key:=regexp_replace(lower(item.key),'[^a-z]','','g');
  if normalized_key ~ '(address|street|postal|postcode|zipcode|geohash|coordinates|exactlocation|placeid)' then
   continue;
  elsif normalized_key in ('lat','latitude','lng','lon','longitude') then
   -- Never pass a malformed or high-precision coordinate through to the client.
   begin
    coordinate:=(item.value #>> '{}')::numeric;
    if abs(coordinate) <= (case when normalized_key in ('lat','latitude') then 90 else 180 end) then
     result:=result||jsonb_build_object(item.key,round(coordinate,2));
    end if;
   exception when invalid_text_representation or numeric_value_out_of_range then null;
   end;
  elsif normalized_key='location' and jsonb_typeof(item.value)='string' then
   result:=result||jsonb_build_object(item.key,coalesce(area_label,''));
  else
   result:=result||jsonb_build_object(item.key,public.short_stay_public_payload(item.value,area_label));
  end if;
 end loop;
 return result;
end $$;
revoke all on function public.short_stay_public_payload(jsonb,text) from public,anon,authenticated;

drop policy if exists short_term_listings_public_select on public.short_term_listings;

create or replace function public.get_bookable_short_term_listings()
returns setof public.short_term_listings
language sql stable security definer set search_path=public,pg_temp as $$
 select (jsonb_populate_record(null::public.short_term_listings,
  to_jsonb(l)||jsonb_build_object('listing_payload',
   public.short_stay_public_payload(l.listing_payload,concat_ws(', ',nullif(l.city,''),nullif(l.country,'')))
   ||jsonb_build_object('realestate',
    coalesce(public.short_stay_public_payload(l.listing_payload->'realestate',concat_ws(', ',nullif(l.city,''),nullif(l.country,''))),'{}'::jsonb)
    ||jsonb_build_object('checkInTime',to_char(f.checkin_time,'HH24:MI'),'checkInTimezone',f.time_zone))
  ))).* from public.short_term_listings l
 join public.profiles p on p.id=l.user_id
 join public.stripe_connected_accounts a on a.user_id=l.user_id
 join public.rental_listing_finance f on f.listing_id=l.id
 join auth.users u on u.id=l.user_id
 where l.status='published' and l.price>0 and p.host_status='approved'
   and u.email_confirmed_at is not null
   and a.details_submitted and a.payouts_enabled
   and a.metadata#>>'{capabilities,transfers}'='active'
   and f.reviewed_at is not null
 order by l.created_at desc;
$$;
revoke all on function public.get_bookable_short_term_listings() from public;
grant execute on function public.get_bookable_short_term_listings() to anon,authenticated,service_role;
