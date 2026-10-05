import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const billingAddress = { country: 'CA', state: 'ON', city: 'Toronto', line1: '100 King St W', postal_code: 'M5X 1A9' };
const request = body => new Request('https://test/functions', {
  method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json', origin: 'https://6ixo.com' },
  body: JSON.stringify({ placement: 'home_featured', amount: 9.99, currency: 'USD', requestId: 'request-1', billingAddress, ...body }),
});

test('the shared promotion catalog loads as an ES module with valid exports', async () => {
  const source = stripTypeScriptTypes(read('supabase/functions/_shared/monetization-catalog.ts'), { mode: 'transform' });
  const catalog = await import('data:text/javascript,' + encodeURIComponent(source));
  assert.equal(catalog.PROMOTION_PRICING_USD.home_featured, 9.99);
  assert.equal(catalog.promotionRequiresTax('home_featured'), true);
  assert.equal(typeof catalog.isSubscriptionPlanKey, 'function');
});

function serverFixture({ rate = 0.13, taxError, promo = false, endpoint = 'create-payment-intent', fxError = false, staleFx = false, supported = ['usd', 'cad', 'jpy', 'gyd', 'ghs', 'eur', 'gbp'] } = {}) {
  const calculations = [], intents = [], sessions = [];
  const stripe = {
    accounts: { retrieve: async () => ({ country: 'CA' }) },
    countrySpecs: { retrieve: async () => ({ supported_payment_currencies: supported }) },
    tax: { calculations: { create: async (args, options) => {
      calculations.push({ args, options });
      if (taxError) throw Error(taxError);
      const subtotal = args.line_items[0].amount, tax = Math.round(subtotal * rate);
      return { id: 'taxcalc_test', amount_total: subtotal + tax, tax_amount_exclusive: tax, currency: args.currency };
    } } },
    paymentIntents: { create: async (args, options) => {
      intents.push({ args, options });
      return { id: 'pi_test', client_secret: 'test_secret', status: 'requires_payment_method', ...args };
    } },
    checkout: { sessions: { create: async args => { sessions.push(args); return { id: 'cs_test', url: 'https://checkout.stripe.com/test' }; } } },
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user', email: 'user@example.test' } } }) },
    from: () => ({ select() { return this; }, ilike() { return this; }, maybeSingle: async () => ({ data: promo ? {
      id: 1, code: 'SAVE25', active: true, discount_type: 'percent', discount_value: 25, currency: 'USD',
    } : null }) }),
  };
  const ctx = { console, Request, Response, Headers, URL, Date, Set, Map, Error, crypto, TextEncoder, Uint8Array, AbortSignal,
    fetch: async () => fxError ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({
      result: 'success', base_code: 'USD', time_last_update_unix: Date.now() / 1000 - (staleFx ? 259200 : 300),
      time_next_update_unix: Date.now() / 1000 + 86000, rates: { USD: 1, CAD: 1.35, JPY: 150.5, GYD: 208.7, GHS: 10.8, EUR: 0.86, GBP: 0.74 },
    })),
    Deno: { env: { get: () => 'configured' }, serve: handler => { ctx.handler = handler; } },
    createClient: () => db, Stripe: function () { return stripe; } };
  for (const name of ['_shared/monetization-catalog.ts', '_shared/promotion-countries.ts', '_shared/promotion-currency.ts', '_shared/promotion-tax.ts', `${endpoint}/index.ts`]) {
    const source = read(`supabase/functions/${name}`).replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '');
    vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }), ctx);
  }
  return { ctx, stripe, calculations, intents, sessions };
}

test('featured promotion charges the server subtotal plus billing-location tax, ignoring client totals and ad destination', async () => {
  const f = serverFixture();
  const response = await f.ctx.handler(request({ targetCountry: 'Guyana', taxAmountCents: 0, amountTotal: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.amountBeforeCents, 999);
  assert.equal(body.taxAmountCents, 130);
  assert.equal(body.amountAfterCents, 1129);
  assert.equal(f.intents[0].args.amount, 1129);
  assert.equal(f.intents[0].args.metadata.tax_calculation_id, 'taxcalc_test');
  assert.equal(f.calculations[0].args.customer_details.address.country, 'CA');
  assert.equal(f.calculations[0].args.customer_details.address_source, 'billing');
  assert.equal(f.calculations[0].args.line_items[0].tax_behavior, 'exclusive');
  assert.equal(f.calculations[0].args.line_items[0].tax_code, 'txcd_10701000');
});

test('every $9.99 featured category used by sponsored arrivals requires a billing address', async () => {
  for (const placement of ['home_featured', 'marketplace_featured', 'community_featured', 'jobs_featured',
    'services_featured', 'vehicles_featured', 'realestate_featured', 'electronics_featured', 'companionship_featured', 'today_deals_featured']) {
    const f = serverFixture();
    assert.equal((await f.ctx.handler(request({ placement, billingAddress: null }))).status, 400, placement);
    assert.equal(f.intents.length, 0);
  }
});

test('tax failures never create a base-price-only payment; legitimate zero tax remains valid', async () => {
  const failed = serverFixture({ taxError: 'Tax settings unavailable' });
  assert.equal((await failed.ctx.handler(request({}))).status, 500);
  assert.equal(failed.intents.length, 0);
  const zero = serverFixture({ rate: 0 });
  const body = await (await zero.ctx.handler(request({}))).json();
  assert.equal(body.taxAmountCents, 0);
  assert.equal(body.taxCalculationId, 'taxcalc_test');
  assert.equal(zero.intents[0].args.amount, 999);
});

test('promo discounts apply before tax and tax does not become part of the discount', async () => {
  const f = serverFixture({ promo: true });
  const body = await (await f.ctx.handler(request({ promoCode: 'SAVE25' }))).json();
  assert.equal(body.discountCents, 250);
  assert.equal(body.subtotalCents, 749);
  assert.equal(body.taxAmountCents, 97);
  assert.equal(body.amountAfterCents, 846);
  assert.equal(f.calculations[0].args.line_items[0].amount, 749);
  assert.equal(f.intents[0].args.metadata.promo_amount_after_cents, '749');
});

test('same address and subtotal reuse payment keys, changed address or discount use new keys', async () => {
  const f = serverFixture({ promo: true });
  await f.ctx.handler(request({}));
  await f.ctx.handler(request({}));
  await f.ctx.handler(request({ billingAddress: { ...billingAddress, state: 'BC' } }));
  await f.ctx.handler(request({ promoCode: 'SAVE25' }));
  assert.equal(f.intents[0].options.idempotencyKey, f.intents[1].options.idempotencyKey);
  assert.notEqual(f.intents[0].options.idempotencyKey, f.intents[2].options.idempotencyKey);
  assert.notEqual(f.intents[0].options.idempotencyKey, f.intents[3].options.idempotencyKey);
});

test('billing country converts the actual charge and tax, while campaign location and client exchange rates cannot change it', async () => {
  const f = serverFixture();
  const response = await f.ctx.handler(request({ localizeCurrency: true, targetCountry: 'Guyana',
    exchangeRate: 0.01, paymentCurrency: 'JPY', amountTotal: 1 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.currency, 'cad');
  assert.equal(body.currencyScale, 100);
  assert.equal(body.paymentBaseMinor, 1349);
  assert.equal(body.subtotalUsdCents, 999);
  assert.equal(body.taxAmountCents, 175);
  assert.equal(body.amountAfterCents, 1524);
  assert.equal(body.exchangeRate, 1.35);
  assert.equal(f.intents[0].args.amount, 1524);
  assert.equal(f.intents[0].args.currency, 'cad');
  assert.equal(f.calculations[0].args.currency, 'cad');
});

test('converted discounts stay in USD for promo accounting and apply before local tax', async () => {
  const f = serverFixture({ promo: true });
  const body = await (await f.ctx.handler(request({ localizeCurrency: true, promoCode: 'SAVE25' }))).json();
  assert.equal(body.paymentBaseMinor, 1349);
  assert.equal(body.paymentDiscountMinor, 338);
  assert.equal(body.subtotalCents, 1011);
  assert.equal(body.taxAmountCents, 131);
  assert.equal(body.amountAfterCents, 1142);
  assert.equal(f.intents[0].args.metadata.promo_currency, 'USD');
  assert.equal(f.intents[0].args.metadata.promo_discount_cents, '250');
  assert.equal(f.intents[0].args.metadata.promo_amount_after_cents, '749');
});

test('zero-decimal and two-decimal currencies use Stripe charge units, and unsupported currencies explicitly fall back to USD', async () => {
  for (const [country, currency, subtotal, scale] of [['JP', 'jpy', 1503, 1], ['GY', 'gyd', 208491, 100], ['GH', 'ghs', 10789, 100]]) {
    const f = serverFixture({ rate: 0 });
    const body = await (await f.ctx.handler(request({ localizeCurrency: true, billingAddress: { ...billingAddress, country } }))).json();
    assert.equal(body.currency, currency);
    assert.equal(body.subtotalCents, subtotal);
    assert.equal(body.currencyScale, scale);
    assert.equal(f.intents[0].args.amount, subtotal);
  }
  const f = serverFixture({ supported: ['usd'] });
  const body = await (await f.ctx.handler(request({ localizeCurrency: true }))).json();
  assert.equal(body.currency, 'usd');
  assert.equal(body.localCurrency, 'CAD');
  assert.equal(body.currencyFallback, true);
});

test('missing, stale or failed exchange quotes prevent payment creation; repeated quotes share the cache', async () => {
  for (const settings of [{ fxError: true }, { staleFx: true }]) {
    const f = serverFixture(settings);
    assert.equal((await f.ctx.handler(request({ localizeCurrency: true }))).status, 503);
    assert.equal(f.intents.length, 0);
  }
  const f = serverFixture();
  let fetches = 0;
  const original = f.ctx.fetch;
  f.ctx.fetch = async (...args) => { fetches++; return original(...args); };
  await f.ctx.handler(request({ localizeCurrency: true }));
  await f.ctx.handler(request({ localizeCurrency: true }));
  assert.equal(fetches, 1);
  assert.equal((await f.ctx.handler(request({ localizeCurrency: true, billingAddress: null }))).status, 400);
});

test('other payment products retain existing pricing; hosted featured Checkout enables exclusive automatic tax', async () => {
  const f = serverFixture();
  assert.equal((await f.ctx.handler(request({ placement: 'arrive_plus', amount: 5.99, billingAddress: null }))).status, 200);
  assert.equal(f.intents[0].args.amount, 599);
  assert.equal(f.calculations.length, 0);
  const checkout = serverFixture({ endpoint: 'create-checkout-session' });
  assert.equal((await checkout.ctx.handler(request({}))).status, 200);
  assert.equal(checkout.sessions[0].automatic_tax.enabled, true);
  assert.equal(checkout.sessions[0].billing_address_collection, 'required');
  assert.equal(checkout.sessions[0].line_items[0].price_data.unit_amount, 999);
  assert.equal(checkout.sessions[0].line_items[0].price_data.tax_behavior, 'exclusive');
  assert.equal(checkout.sessions[0].line_items[0].price_data.product_data.tax_code, 'txcd_10701000');
});

test('tax transactions and refund reversals survive repeated webhook deliveries without duplication', async () => {
  const f = serverFixture(), recorded = [], reversed = [];
  const intent = { id: 'pi_paid', status: 'succeeded', metadata: { tax_calculation_id: 'taxcalc_paid' } };
  const refunds = [
    { id: 're_first', amount: 500, status: 'succeeded', metadata: {} },
    { id: 're_remaining', amount: 629, status: 'succeeded', metadata: {} },
    { id: 're_pending', amount: 10, status: 'pending', metadata: {} },
  ];
  Object.assign(f.stripe.paymentIntents, {
    retrieve: async () => intent,
    update: async (id, args) => { Object.assign(intent.metadata, args.metadata); },
  });
  f.stripe.tax.transactions = {
    createFromCalculation: async (args, options) => { recorded.push({ args, options }); return { id: 'tax_recorded' }; },
    createReversal: async (args, options) => { reversed.push({ args, options }); return { id: `tax_${args.reference}` }; },
  };
  f.stripe.refunds = {
    list: async () => ({ data: refunds, has_more: false }),
    update: async (id, args) => { Object.assign(refunds.find(r => r.id === id).metadata, args.metadata); },
  };
  await f.ctx.recordPromotionTaxTransaction(f.stripe, { ...intent, metadata: { ...intent.metadata } });
  await f.ctx.recordPromotionTaxTransaction(f.stripe, { ...intent, metadata: { tax_calculation_id: 'taxcalc_paid' } });
  const charge = { id: 'ch_paid', payment_intent: 'pi_paid' };
  await f.ctx.reversePromotionTaxRefunds(f.stripe, charge);
  await f.ctx.reversePromotionTaxRefunds(f.stripe, charge);
  assert.equal(recorded.length, 1);
  assert.deepEqual(reversed.map(r => r.args.flat_amount), [-500, -629]);
  assert.equal(reversed.reduce((sum, r) => sum + r.args.flat_amount, 0), -1129);
});

function browserFixture() {
  const ids = ['promotion-fee-modal', 'promotion-fee-amount', 'promotion-fee-final-amount', 'promotion-fee-tax-amount',
    'promotion-fee-pay', 'promotion-fee-status', 'promotion-billing-address-wrap', 'stripe-payment-modal', 'stripe-payment-amount',
    'stripe-payment-element', 'stripe-payment-submit', 'stripe-payment-cancel', 'stripe-payment-status', 'stripe-promotion-tax-summary',
    'stripe-promotion-base', 'stripe-promotion-discount', 'stripe-promotion-tax', 'stripe-promotion-total'];
  const elements = Object.fromEntries(ids.map(id => [id, { textContent: '', disabled: false,
    classList: { hidden: true, add(name) { if (name === 'hidden') this.hidden = true; }, remove(name) { if (name === 'hidden') this.hidden = false; },
      toggle(name, hidden) { if (name === 'hidden') this.hidden = hidden; } } }]));
  const ctx = { console, Date, Set, Map, URL, Intl, document: { getElementById: id => elements[id] || null },
    window: { STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture', setTimeout() {} } };
  const source = read('app.js');
  vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', ctx);
  const app = Object.create(ctx.App.prototype);
  app.promotionFees = { featured: { default: 9.99 } };
  app.logAnalyticsEvent = () => {};
  app.getPromotionCustomerRef = () => 'user';
  app.showNotification = () => {};
  const pending = { placement: 'home_featured', amountBase: 9.99, amount: 9.99, currency: 'USD', billingAddress, billingName: 'Test User' };
  app.pendingPromotionFee = pending;
  return { app, pending, elements };
}

test('payment UI displays the server tax and total and confirms with the same billing address', async () => {
  const f = browserFixture(); let payload, confirmation;
  const card = { on() {}, mount() {}, unmount() {} };
  f.app.getStripeClient = async () => ({
    elements: () => ({ create: () => card, submit: async () => ({}) }),
    confirmPayment: async args => { confirmation = args; return { paymentIntent: { id: 'pi_paid', status: 'succeeded' } }; },
  });
  f.app.callSupabaseFunction = async (name, args) => {
    payload = args;
    return { id: 'pi_paid', clientSecret: 'test_secret', amountBeforeCents: 999, subtotalCents: 999,
      amountAfterCents: 1129, taxAmountCents: 130, taxCalculationId: 'taxcalc_test' };
  };
  f.app.verifyPromotionPayment = async () => ({ paid: true });
  const payment = f.app.startStripePromotionCheckout({ pending: f.pending, paymentMethod: 'credit_card' });
  while (!f.app.pendingStripePayment) await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload.billingAddress, billingAddress);
  assert.equal(f.elements['stripe-promotion-tax'].textContent, 'USD\u00a01.30');
  assert.equal(f.elements['stripe-promotion-total'].textContent, 'USD\u00a011.29');
  assert.equal(f.elements['stripe-payment-submit'].textContent, 'Pay USD\u00a011.29');
  assert.equal(f.pending.amount, 9.99);
  f.app.stripePaymentElementReady = true;
  await f.app.submitStripePaymentModal();
  assert.equal((await payment).paid, true);
  assert.equal(confirmation.confirmParams.payment_method_data.billing_details.address, billingAddress);
});

test('incomplete billing addresses and missing server tax prevent payment confirmation', async () => {
  const f = browserFixture(); let opened = false;
  f.app.setupPromotionBillingAddress = async () => ({ getValue: async () => ({ complete: false }) });
  f.app.startStripePromotionCheckout = async () => { opened = true; };
  await f.app.payPromotionFeeAndContinue();
  assert.equal(opened, false);
  assert.equal(f.elements['promotion-fee-pay'].disabled, false);
  const g = browserFixture();
  g.app.getStripeClient = async () => ({ elements: () => { throw Error('Card form must not open'); } });
  g.app.callSupabaseFunction = async () => ({ id: 'pi_old_backend', clientSecret: 'test_secret', amountBeforeCents: 999, amountAfterCents: 999 });
  await assert.rejects(g.app.startStripePromotionCheckout({ pending: g.pending }), /Tax could not be calculated/);
});

test('payment screen shows CAD totals without replacing the USD promotion or promo amounts', async () => {
  const f = browserFixture();
  f.app.getStripeClient = async () => ({ elements: () => ({ create: () => ({ on() {}, mount() {}, unmount() {} }) }) });
  f.app.callSupabaseFunction = async () => ({ id: 'pi_cad', clientSecret: 'cad_secret',
    currency: 'cad', currencyScale: 100, amountBeforeCents: 999, subtotalUsdCents: 999, subtotalCents: 1349,
    paymentBaseMinor: 1349, paymentDiscountMinor: 0, taxAmountCents: 175, amountAfterCents: 1524, taxCalculationId: 'taxcalc_cad' });
  const payment = f.app.startStripePromotionCheckout({ pending: f.pending });
  while (!f.app.pendingStripePayment) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.amount, 9.99);
  assert.equal(f.pending.paymentCurrency, 'CAD');
  assert.equal(f.elements['stripe-promotion-tax'].textContent, 'CAD\u00a01.75');
  assert.equal(f.elements['stripe-promotion-total'].textContent, 'CAD\u00a015.24');
  assert.equal(f.elements['stripe-payment-submit'].textContent, 'Pay CAD\u00a015.24');
  assert.equal(f.app.formatPromotionMoney(1503, 'JPY', 1), 'JPY\u00a01,503');
  f.app.closeStripePaymentModal();
  assert.equal((await payment).paid, false);
});

test('cancelling during tax calculation cannot reopen the payment form or leave a pending confirmation', async () => {
  const f = browserFixture(); let finish;
  f.app.getStripeClient = async () => ({ elements: () => { throw Error('Cancelled card form must not open'); } });
  f.app.callSupabaseFunction = () => new Promise(resolve => { finish = resolve; });
  const checkout = f.app.startStripePromotionCheckout({ pending: f.pending });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.elements['stripe-payment-submit'].disabled, true);
  f.app.closeStripePaymentModal();
  finish({ clientSecret: 'cancelled', amountAfterCents: 1129 });
  assert.equal((await checkout).reason, 'cancelled');
  assert.equal(f.app.pendingStripePayment, null);
  assert.equal(f.elements['stripe-payment-modal'].classList.hidden, true);
});
