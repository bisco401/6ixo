-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Keep public
-- availability read-only and require an authenticated role for account data.

revoke execute on function public.create_vehicle_rental_listing(jsonb) from public, anon;
revoke execute on function public.create_vehicle_rental_booking(text, jsonb) from public, anon;
revoke execute on function public.get_my_vehicle_rental_bookings() from public, anon;
revoke execute on function public.get_host_vehicle_rental_bookings() from public, anon;
revoke execute on function public.get_or_create_vehicle_rental_booking_conversation(text) from public, anon;
revoke execute on function public.get_my_marketplace_conversations() from public, anon;
grant execute on function public.create_vehicle_rental_listing(jsonb) to authenticated;
grant execute on function public.create_vehicle_rental_booking(text, jsonb) to authenticated;
grant execute on function public.get_my_vehicle_rental_bookings() to authenticated;
grant execute on function public.get_host_vehicle_rental_bookings() to authenticated;
grant execute on function public.get_or_create_vehicle_rental_booking_conversation(text) to authenticated;
grant execute on function public.get_my_marketplace_conversations() to authenticated;
