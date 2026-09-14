# Car rentals: operation and acceptance

6ixo car rentals use a 10% guest service fee on the base daily rental charge, full guest refunds until 24 hours before pickup, and host transfer eligibility 24 hours after pickup. This extends the existing account, messaging, Stripe Express, and booking dashboards with a vehicle-specific workflow.

## Host application and vehicle review

1. Sign up, verify the account email, and open the car rental host application from the profile. Provide identity, ownership/authorization, registration, rental-use insurance, safety/support agreements, and vehicle photos. Uploads remain private; incomplete drafts do not reach admin review.
2. Admin reviews a submitted application, its documents and photos, and approves, declines, or requests more information. The decision and notification queue commit together. Approval emails explain the Stripe setup step.
3. The host completes their own Stripe Express identity and bank onboarding. Add the car's photos, daily price, currency, features, availability, delivery option and rules. New cars save as drafts.
4. **Admin → Car rental operations** lists vehicle drafts. Review the actual insurance covering this specific vehicle on 6ixo, coverage expiry, eligibility/minimum driver age, time zone, default pickup/return times, included distance, extra-distance rate, delivery fee, pickup/return instructions, support contact and applicable taxes. Explicitly enable bookings after review. The host can then publish from their rental listings.
5. Host controls include publish, pause, archive, daily-price updates and blocked dates. Existing booking quotes do not change when a vehicle's future price or tax settings change.

Insurance coverage is not supplied by this software. A personal vehicle policy or a policy covering rentals on another marketplace is not treated as proof of coverage on 6ixo. Approval must be based on the actual documents and the business's coverage arrangements. Driver approval is a documented human review, not an automated identity/background-check service.

## Guest booking and trip

The guest selects pickup and return dates and local times, enters driver details, and uploads their licence privately. Supabase checks host/vehicle eligibility, coverage expiry, minimum age, licence validity, availability and overlapping holds. Each started 24-hour period is billed as a day. Quotes snapshot the rental, 10% service fee, optional delivery, reviewed taxes, mileage terms, refund deadline and host release deadline. The final server quote is shown before payment.

Requested bookings authorize a card; the host reviews the driver in **Trip details**, then approves/captures or declines/releases the authorization from the booking card. Instant bookings capture immediately, with driver review still required before pickup. Stripe authorization limits apply: an authorization that expires before approval must not be represented as a confirmed paid trip.

Both participants can open Trip details and save pickup/return photos, odometer readings and fuel/battery levels. The host records actual handover and return. Pickup requires a paid confirmed booking and approved driver; return readings cannot precede pickup or decrease the odometer. Guests and hosts can report an issue; admins record its resolution. Condition/mileage records do not automatically charge extra amounts to a card. Additional charges, damage claims, roadside assistance and disagreements require the business's actual support process.

Pickup/return directions are booking information, not a secure key-storage system. Do not place unlock codes, passwords or alarm codes in listing or booking instructions. Coordinate access with the verified driver through the existing participant messaging workflow.

## Payments, taxes, refunds and bank payouts

New cars use separate platform charges and delayed transfers. The maintenance worker releases the recorded host share only after the deadline, successful capture, driver approval and recorded pickup, with no open issue, refund or dispute. It checks Stripe account readiness immediately before transfer. Stable transfer groups and idempotency keys prevent duplicate transfers and permit recovery after interrupted writes.

The host receives rental and delivery amounts plus any host-remitted taxes. The 10% fee and platform-remitted taxes remain with 6ixo. Stripe costs and tax filing/remittance remain business accounting responsibilities. Tax rules are reviewed per vehicle; Canada/GST-HST registration does not determine every provincial car-rental tax or an individual host's obligations. No accommodation-tax configuration is copied into vehicle rentals.

Eligible guest cancellations return the full captured charge, including fee and tax. Host/admin cancellations can release authorizations or refund captured payments. A refund after transfer reverses host funds; recovery failures stay visible for retry. Open trip issues hold unreleased funds; an issue reported after transfer needs admin handling and does not itself claw back money. A financial refund/dispute is reconciled with Stripe separately.

Transfer eligibility is distinct from bank arrival. Stripe settlement, verification, available balances, the connected account payout schedule and banking delays determine bank arrival. Keep an adequate platform balance for transfers/refunds and review any failed payout in Stripe.

## Notifications and maintenance

The vehicle outbox retries application, decision, booking, cancellation/refund and admin issue emails. Recipients come from verified account records, never a supplied booking email. Licence numbers are not emailed. Superseded messages are skipped; Resend idempotency keys reduce duplicate delivery. The existing minute-by-minute `rental-maintenance` job processes vehicle jobs alongside stays using separate ledgers and payment leases.

Deploy the five `20260914` vehicle migrations and `create-payment-intent`, `manage-booking-payment`, `stripe-webhook`, `rental-maintenance`, `send-host-email`, and `send-vehicle-rental-email`. Preserve `connect-account` and the existing Stripe platform/Connect webhook destinations, worker secret and scheduler. Function authentication checks remain in the handlers: validated user sessions and participant/admin ownership, Stripe signatures, or the dedicated worker secret.

## Verification and launch acceptance

Run `npm test` for stay and vehicle regressions, or `npm run test:vehicle-rentals` for the vehicle-specific database, payment, notification and frontend tests. Embedded PostgreSQL executes actual migrations and permissions; provider unit tests cover retries and failure paths. Isolated browser tests check real forms at mobile and desktop widths.

Sandbox acceptance additionally uses real Supabase accounts/storage and Stripe's official test identity, card and bank tokens, with no live money. A test Custom account can exercise transfers; it does not replace a real host completing Express onboarding. Tests may accelerate the release clock explicitly, while ordinary requests retain the 24-hour deadline.

Before accepting public trips, verify real rental-use coverage and vehicle eligibility, complete a real host's Express onboarding, and perform a supervised legitimate booking/handover/return with its real payment and bank payout reconciled. Automated tests do not prove insurance coverage, a physical handover, or bank settlement. No live financial transaction is made by the test scripts.

References: [Stripe Connect testing](https://docs.stripe.com/connect/testing), [Stripe separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers), [Turo Canada trip structure](https://turo.com/ca/en/car-rental/canada/how-turo-works). The flow is inspired by marketplace car-rental patterns; it does not claim Turo's protection plans or support services.
