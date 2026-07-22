-- Older vehicle-rental rows predate the write trigger that strips hostEmail.
-- The booking flow resolves the host's email from auth.users on the server.
update public.marketplace_listings
   set listing_payload = listing_payload - 'hostEmail'
 where listing_payload ? 'hostEmail';
