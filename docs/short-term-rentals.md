# Short-term rentals: operation and acceptance

6ixo is configured for the business decisions supplied on 12 September 2026: Canada, GST/HST registered, a 12% guest service fee on nightly accommodation charges, full guest refunds until 24 hours before check-in, and host funds eligible for release 24 hours after check-in.

## Host and admin workflow

1. The host signs up, verifies their email, and submits an application with proof and property photos. Drafts remain outside the admin review inbox until uploads finish.
2. Admin reviews the submitted application and approves, declines, or requests more information. Application and profile statuses update together. Notification messages are committed in the same transaction.
3. The approved host completes Stripe Express identity and bank onboarding and posts the stay with persistent photos, nightly price, cleaning fee, guest capacity, and availability.
4. **Admin → Rental taxes and payouts** shows the property. Set its actual time zone and check-in time, review each applicable tax, identify who remits it, and save the review. Bookings are blocked until this step is complete. This accommodates different host registration statuses and provincial/municipal accommodation taxes. The Canadian province picker supplies a GST/HST starting rate; it does not decide every tax liability.
5. The guest chooses dates. Supabase calculates the price and taxes, snapshots the financial terms, and holds the dates for 30 minutes. The payment form shows the final amount and tax breakdown before authorization or payment.
6. Requested bookings authorize a card until host approval; instant bookings capture immediately. Eligible cancellations refund the guest. The cancellation deadline and release time use the property's time zone and preserve the agreed absolute timestamps.

## Taxes and financial records

Each tax has a name, a percentage or nightly amount, taxable components, and a remitting party (6ixo or the host). Tax rules can include earlier taxes in the calculation and exempt stays of one calendar month or longer. Apply rules in the order shown. Zero rates are omitted. Admin must document the tax review, including any exemptions or zero-tax treatment. The registration confirmation supplied in this task does not establish each individual host's registration status or the applicable municipal obligations.

Every new booking records the tax breakdown, platform fee, host funds, local check-in, refund deadline, and release deadline. Later property tax edits cannot alter an existing booking. Platform-remitted taxes stay with 6ixo; host-remitted tax amounts are included in the host transfer. Filing and remittance to tax authorities remain business operations, not actions performed by this code.

Canadian GST/HST rates used by the province picker are 5%, Ontario 13%, Nova Scotia 14%, and New Brunswick/Newfoundland and Labrador/Prince Edward Island 15%. Province and city accommodation taxes require review. [CRA platform accommodation rules and current rates](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/charge-collect/platform-based-accommodation.html).

## Payout and refund operation

New stays use separate Stripe charges and transfers. Capture retains the charge on the platform; it does not immediately transfer host funds. The maintenance worker releases only the recorded host amount after the due time, once the payment is captured, undisputed, unrefunded, and the host's account is ready. The service fee and platform-remitted taxes remain on the platform. Stripe processing, dispute, and refund costs must be accounted for separately.

A payment lease serializes release/capture/cancellation. Transfer groups and stable idempotency keys prevent duplicate releases and recover a successful transfer whose database save failed. Refunds and disputes freeze or reverse transfers. A guest refund does not wait for recovery of funds already sent to a host; failed recovery stays visible and retries. Bank payout events appear in the host's profile separately from transfers to their Stripe balance.

**Stripe operational requirement:** preserve enough platform balance for future host transfers and refunds. Review the platform bank payout schedule/reserve before enabling customer checkout. Transfer eligibility 24 hours after check-in is distinct from bank arrival; provider verification, settlement, available funds, and banking delays can postpone arrival. [Stripe transfer source transactions](https://docs.stripe.com/api/transfers/create).

Older bookings retain their original destination-charge behavior. New tax settings and delayed transfers apply to newly created bookings only.

## Background worker

`rental-maintenance` is protected by a dedicated `RENTAL_WORKER_SECRET`. The matching credential is stored in Supabase Vault as `rental_worker_token`; `rental_runtime_config` contains the project URL. The `6ixo-rental-maintenance` pg_cron job invokes the worker every minute. It retries due notifications with backoff, skips superseded application messages, processes due host transfers, and retries recovery of refunded/disputed transfers. It cannot be invoked with a public browser key.

Deploy the finance and scheduler migrations and these functions: `create-payment-intent`, `manage-booking-payment`, `stripe-webhook`, `send-host-email`, and `rental-maintenance`. Keep the previously deployed `connect-account` function. Deploy their shared modules together. Set the worker credential in server secrets and Vault; never put it in browser configuration or Git.

## Stripe event destinations

The platform destination uses `/functions/v1/stripe-webhook` and `STRIPE_WEBHOOK_SECRET`. Include payment-intent success/capturable/failure/cancellation/processing, `charge.refunded`, `refund.updated`, `refund.failed`, and charge dispute creation/closure. Preserve existing checkout/subscription/invoice events used by other 6ixo features.

The Connect destination points to the same function with **Events from: Connected accounts**. Include `account.updated`, `payout.paid`, `payout.failed`, `payout.updated`, and `payout.canceled`; save its distinct signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET`. Signatures and live/test mode are checked. [Stripe Connect webhooks](https://docs.stripe.com/connect/webhooks).

## Validation and external access

Run `npm ci` and `npm test` with Node 24. Automated tests execute the schema/RLS in embedded PostgreSQL and actual payment-handler code against controlled provider responses. Browser acceptance uses local test fixtures with external requests blocked. These checks do not prove real email delivery or bank settlement.

A full provider acceptance test needs a separate Supabase test project and a Stripe sandbox. Create the sandbox through Stripe's account picker and configure its test keys and signing secrets in that test project. Never replace production keys with test keys. [Stripe sandbox management](https://docs.stripe.com/sandboxes/dashboard/manage).

Real hosts must complete their own identity and bank verification in Stripe. No invented identity, registration number, bank account, or real customer charge is used for acceptance tests.
