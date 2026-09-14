-- A released authorization has no host funds to pay. Keep its ledger in sync.
create or replace function public.close_cancelled_vehicle_finance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status in ('cancelled','declined') and new.payment_status in ('cancelled','refunded') then
  update vehicle_booking_finance set payout_status='cancelled',last_error=null
  where booking_id=new.id and stripe_transfer_id is null and payout_status in ('pending','held');
 end if;
 return new;
end $$;
create trigger vehicle_finance_close_cancelled after update of status,payment_status on vehicle_rental_bookings
for each row execute function public.close_cancelled_vehicle_finance();
revoke all on function public.close_cancelled_vehicle_finance() from public,anon,authenticated;
