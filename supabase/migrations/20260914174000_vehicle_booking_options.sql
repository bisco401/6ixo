-- Only host-offered delivery can be purchased. Public availability reveals times, not identities.
create or replace function public.snapshot_vehicle_booking_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare f public.vehicle_listing_finance; rule jsonb; tax bigint:=0; host_tax bigint:=0; amount bigint; basis numeric; lines jsonb:='[]'; delivery bigint:=0;
begin
 select f0.* into f from vehicle_listing_finance f0 join marketplace_listings l on l.id=f0.listing_id where l.public_id=new.listing_public_id;
 if not found or not f.enabled then raise exception 'Vehicle financial review is required.'; end if;
 if coalesce((new.booking_payload->>'deliveryRequested')::boolean,false) then
  if not exists(select 1 from marketplace_listings where public_id=new.listing_public_id and coalesce((listing_payload->>'deliveryAvailable')::boolean,false)) then raise exception 'This host does not offer vehicle delivery.';end if;
  delivery:=f.delivery_fee_cents;
 end if;
 for rule in select * from jsonb_array_elements(f.tax_rules) loop
  if rule->>'kind'='per_day' then amount:=round((rule->>'rate')::numeric*new.trip_days*100);
  else basis:=case when coalesce((rule->>'rental')::boolean,false) then new.daily_rate*new.trip_days else 0 end
   +case when coalesce((rule->>'delivery')::boolean,false) then delivery/100.0 else 0 end
   +case when coalesce((rule->>'service')::boolean,false) then new.service_fee else 0 end;
   amount:=round(basis*(rule->>'rate')::numeric);
  end if;
  tax:=tax+amount; if rule->>'recipient'='host' then host_tax:=host_tax+amount; end if;
  lines:=lines||jsonb_build_array(rule||jsonb_build_object('amountCents',amount));
 end loop;
 new.total:=round(new.daily_rate*new.trip_days+new.service_fee+(delivery+tax)/100.0,2);
 new.booking_payload:=new.booking_payload||jsonb_build_object('payoutMode','delayed_transfer','rentalType','vehicle_rental','serviceFeeRate',0.10,
 'taxAmountCents',tax,'taxBreakdown',lines,'deliveryFeeCents',delivery,'computedTotal',new.total,
 'hostAmountCents',round(new.daily_rate*new.trip_days*100)+delivery+host_tax,'vehicleTimeZone',f.time_zone,
 'cancellationDeadline',(new.booking_payload->>'pickupAt')::timestamptz-interval '24 hours','payoutDueAt',(new.booking_payload->>'pickupAt')::timestamptz+interval '24 hours',
 'includedDistance',f.included_distance_per_day*new.trip_days,'distanceUnit',f.distance_unit,'excessDistanceRateCents',f.excess_distance_rate_cents,
 'coverageSummary',f.coverage_summary,'pickupInstructions',f.pickup_instructions,'returnInstructions',f.return_instructions,'supportContact',f.support_contact,'financialTermsVersion',f.reviewed_at);
 return new;
end $$;

create or replace function public.get_vehicle_rental_booking_windows(p_listing_public_id text)
returns jsonb language sql security definer set search_path=public,pg_temp stable as $$
 select coalesce(jsonb_agg(jsonb_build_object('start',coalesce(b.booking_payload->>'pickupAt',b.pickup_date::text||'T00:00:00Z'),'end',coalesce(b.booking_payload->>'returnAt',b.return_date::text||'T23:59:59Z'))),'[]')
 from vehicle_rental_bookings b join marketplace_listings l on l.public_id=b.listing_public_id
 where l.public_id=p_listing_public_id and l.status='published' and b.status in ('requested','confirmed')
 and b.return_date>=current_date and (b.payment_status in ('authorized','paid','processing') or (b.payment_status in ('unpaid','requires_payment_method') and coalesce(b.hold_expires_at,b.created_at+interval '30 minutes')>now()));
$$;
revoke all on function public.get_vehicle_rental_booking_windows(text) from public;
grant execute on function public.get_vehicle_rental_booking_windows(text) to anon,authenticated;
