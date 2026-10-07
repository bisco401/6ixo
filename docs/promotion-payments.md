# Promotion pricing, tax and payment currency

Home featured placement costs **US$14.99 plus applicable tax for 7 days**.
Services and Real Estate featured placements remain **US$9.99 plus applicable
tax for 7 days**. Sponsored arrivals use the destination category's featured
placement and its catalog price, rather than the separate Arrive Plus
trip-request product. Tax eligibility follows the placement, not its price.

Featured ad inventory is a paid service for real customers. Imported feeds may
fill unused slots temporarily; those fillers are not payment entitlements and
are not presented as paying advertisers. Verified paid ads take the first slots,
and fillers shrink as paid inventory grows. Ordinary unpaid user listings stay
in their normal feeds. The server's featured flag controls paid listing delivery;
a user-supplied payload flag cannot activate featuring.

The catalog and promo-code discounts remain in USD. Checkout collects a complete
Stripe billing address, chooses that country's legal tender from Unicode CLDR,
checks the merchant's supported Stripe currencies, and converts the discounted
subtotal on the server using ExchangeRate-API's daily USD rates. Rates are cached
per worker until the next update; concurrent requests share a fetch. Stale or
unavailable rates block payment creation. The UI attributes the provider.

Stripe Tax calculates exclusive tax in the actual charge currency using Website
Advertising tax code `txcd_10701000`. The payment intent charges the subtotal plus
tax. The customer sees the converted base price, discount, tax, total and payment
currency before confirming. Zero-decimal currencies use Stripe's charge units.
Unsupported currencies (including ISK/UGX with special whole-unit tax rounding)
fall back to USD with an explicit checkout notice.

Tax settings and applicable registrations must be configured in Stripe for the
same live/test account as the payment keys. Stripe can legitimately return zero
tax where no tax is due or no active registration applies. A tax calculation
failure blocks payment rather than collecting only the base price.

Signed webhooks record paid tax calculations and reverse the tax for successful
refunds. Stripe metadata and idempotency keys prevent repeat tax records.
Promo redemptions explicitly retain their original USD currency and amounts.

Run `npm run test:promotion-tax` and `npm test`. Deploy the three affected
functions with `supabase functions deploy create-payment-intent create-checkout-session stripe-webhook --use-api --project-ref rxhzxlzpiwkqcxtrrlnd`.
The frontend is GitHub Pages from the repository's main branch, using `app.js`.
Update its query version and `build-version.txt` when publishing.

Sources:

- https://docs.stripe.com/tax/payment-intent/custom
- https://docs.stripe.com/currencies
- https://docs.stripe.com/api/country_specs/object
- https://www.exchangerate-api.com/docs/free
- https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/currencyData.json
