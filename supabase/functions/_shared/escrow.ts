// Escrow.com holds and disburses all funds. Browser input never sets a beneficiary or fee.
export const ESCROW_POLICY = Object.freeze({
  minimumAmount: 1000,
  serviceFeeBps: 200,
  minimumServiceFee: 20,
  maximumServiceFee: 500,
  inspectionDays: 3,
  version: '2026-10-14.1',
});
export class EscrowError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function currencyCode(value: unknown): string {
  const code = String(value || '').trim().toLowerCase();
  if (!['usd', 'cad', 'aud', 'eur', 'euro', 'gbp'].includes(code)) {
    throw new EscrowError(400, 'Escrow currently supports CAD, USD, AUD, EUR and GBP. This listing currency is not supported.');
  }
  return code === 'eur' ? 'euro' : code;
}
export function moneyCents(value: unknown): number {
  if (value === null || value === undefined || value === '') throw new EscrowError(400, 'A saved item price is required.');
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.000001) {
    throw new EscrowError(400, 'The saved item price must be positive and have at most two decimal places.');
  }
  return cents;
}
export function serviceFeeCents(amountCents: number): number {
  return Math.min(ESCROW_POLICY.maximumServiceFee * 100,
    Math.max(ESCROW_POLICY.minimumServiceFee * 100, Math.round(amountCents * ESCROW_POLICY.serviceFeeBps / 10000)));
}
export function assertListing(listing: any, buyerId: string): void {
  if (!listing || listing.status !== 'published') throw new EscrowError(409, 'This listing is no longer available.');
  if (!listing.user_id || listing.user_id === buyerId) throw new EscrowError(400, 'You cannot buy your own listing.');
  const payload = listing.listing_payload || {};
  if (!['electronics', 'vehicles', 'auto_parts', 'clothing', 'buy_sell', 'furniture', 'home', 'sports'].includes(listing.category)
    || payload.escrowEligible === false || payload.secureDealEligible === false
    || payload.liveAuction?.enabled || payload.vehicleRental?.enabled || payload.vehicle?.rental
    || ['rentals', 'car_rentals', 'rental'].includes(payload.vehicle?.category)
    || ['rentals', 'car_rentals', 'rental'].includes(listing.subcategory)) {
    throw new EscrowError(400, 'Escrow is available for eligible fixed-price items sold by registered 6ixo sellers.');
  }
  currencyCode(listing.currency);
  if (moneyCents(listing.price) < ESCROW_POLICY.minimumAmount * 100) throw new EscrowError(400, 'Escrow is available for items priced at 1,000 or more in a supported currency.');
}
export function providerUrls(base: string) {
  const normalized = base.replace(/\/+$/, '');
  if (!['https://api.escrow.com/2017-09-01', 'https://api.escrow-sandbox.com/2017-09-01'].includes(normalized)) {
    throw new EscrowError(503, 'Escrow provider configuration is invalid.');
  }
  const sandbox = normalized.includes('escrow-sandbox');
  return { api: normalized, pay: `${new URL(normalized).origin}/integration/pay/2018-03-31`,
    website: sandbox ? 'https://www.escrow-sandbox.com' : 'https://www.escrow.com', sandbox };
}
export function checkoutUrl(value: unknown, sandbox: boolean): string {
  try {
    const url = new URL(String(value || ''));
    const host = sandbox ? 'www.escrow-sandbox.com' : 'www.escrow.com';
    if (url.protocol !== 'https:' || url.hostname !== host || url.pathname !== '/pay' || !url.searchParams.get('token')) throw new Error();
    return url.href;
  } catch { throw new EscrowError(502, 'Escrow.com did not return a valid checkout link. Please check My escrow deals before trying again.'); }
}
export function transactionPayload(listing: any, buyerEmail: string, sellerEmail: string, reference: string) {
  const cents = moneyCents(listing.price);
  const fee = serviceFeeCents(cents);
  const fees = [{ type: 'escrow', payer_customer: buyerEmail, split: 1 }];
  return {
    currency: currencyCode(listing.currency),
    description: `6ixo purchase: ${String(listing.title).slice(0,180)}. Three calendar days to inspect after confirmed delivery.`,
    reference,
    parties: [
      { role: 'buyer', customer: buyerEmail, lock_email: true },
      { role: 'seller', customer: sellerEmail },
      { role: 'broker', customer: 'me', initiator: true },
    ],
    items: [
      { title: String(listing.title).slice(0,180), description: String(listing.description || listing.title).slice(0,2000),
        type: listing.category === 'vehicles' ? 'motor_vehicle' : 'general_merchandise',
        quantity: 1, inspection_period: ESCROW_POLICY.inspectionDays * 86400,
        schedule: [{ amount: cents / 100, payer_customer: buyerEmail, beneficiary_customer: sellerEmail }], fees },
      { title: '6ixo service fee', type: 'broker_fee',
        schedule: [{ amount: fee / 100, payer_customer: buyerEmail, beneficiary_customer: 'me' }], fees },
    ],
  };
}
export function transactionStatus(transaction: any): string {
  const items = (transaction.items || []).filter((item: any) => ['general_merchandise', 'motor_vehicle', 'domain_name', 'milestone'].includes(item.type));
  if (!items.length) throw new EscrowError(502, 'Escrow.com returned incomplete transaction details.');
  const schedules = items.flatMap((item: any) => item.schedule || []);
  const everyItem = (key: string) => items.every((item: any) => item.status?.[key] === true);
  const everyPayment = (key: string) => schedules.length > 0 && schedules.every((s: any) => s.status?.[key] === true);
  if (everyPayment('disbursed_to_payer')) return 'refunded';
  if (everyPayment('disbursed_to_beneficiary')) return 'paid';
  if (everyItem('canceled') || everyItem('cancelled')) return 'cancelled';
  if (items.some((item: any) => item.status?.rejected_returned)) return 'disputed';
  if (everyItem('received_returned')) return 'returned';
  if (items.some((item: any) => item.status?.rejected)) return 'return_requested';
  if (everyItem('accepted')) return 'accepted';
  if (everyItem('received')) return 'inspection';
  if (everyItem('shipped')) return 'shipped';
  if (everyPayment('secured')) return 'funded';
  if (everyPayment('payment_received')) return 'payment_review';
  if (everyPayment('payment_sent')) return 'payment_pending';
  const parties = (transaction.parties || []).filter((party: any) => ['buyer','seller'].includes(party.role));
  return parties.length === 2 && parties.every((party: any) => party.agreed) ? 'awaiting_payment' : 'awaiting_agreement';
}
export function validateTransaction(transaction: any, order: any, brokerEmail = ''): void {
  const buyer = transaction.parties?.find((p: any) => p.role === 'buyer');
  const seller = transaction.parties?.find((p: any) => p.role === 'seller');
  const normalize = (s: unknown) => String(s || '').toLowerCase().trim();
  if (String(transaction.id) !== String(order.escrow_transaction_id)
    || normalize(buyer?.customer) !== normalize(order.buyer_email)
    || normalize(seller?.customer) !== normalize(order.seller_email)
    || currencyCode(transaction.currency) !== currencyCode(order.currency)) {
    throw new EscrowError(502, 'Escrow transaction verification failed.');
  }
  const items = (transaction.items || []).filter((i: any) => ['general_merchandise','motor_vehicle'].includes(i.type));
  if (items.some((item: any) => (item.schedule || []).some((schedule: any) =>
    normalize(schedule.payer_customer) !== normalize(order.buyer_email) || normalize(schedule.beneficiary_customer) !== normalize(order.seller_email)))) {
    throw new EscrowError(502,'The escrow payment parties do not match the order.');
  }
  const total = items.reduce((sum: number, i: any) => sum + (i.schedule || []).reduce((n: number, s: any) => n + moneyCents(s.amount), 0), 0);
  if (total !== moneyCents(order.amount)) throw new EscrowError(502, 'Escrow transaction amount does not match the order.');
  if (Number(order.service_fee) > 0) {
    const broker = transaction.parties?.find((p: any) => p.role === 'broker');
    const fees = (transaction.items || []).filter((i: any) => i.type === 'broker_fee').flatMap((i: any) => i.schedule || []);
    if (normalize(broker?.customer) !== normalize(brokerEmail) || fees.length !== 1
      || normalize(fees[0].payer_customer) !== normalize(order.buyer_email)
      || normalize(fees[0].beneficiary_customer) !== normalize(brokerEmail)
      || moneyCents(fees[0].amount) !== moneyCents(order.service_fee)) {
      throw new EscrowError(502,'The marketplace service fee could not be verified.');
    }
  }
}
export function publicOrder(order: any, userId: string, sandbox: boolean) {
  return { id: order.public_id, listingId: order.listing_public_id, title: order.listing_snapshot?.title || 'Escrow purchase',
    amount: Number(order.amount), serviceFee: Number(order.service_fee || 0), currency: order.currency === 'euro' ? 'EUR' : String(order.currency).toUpperCase(),
    status: order.status, role: order.buyer_user_id === userId ? 'buyer' : 'seller',
    checkoutUrl: order.buyer_user_id === userId ? order.checkout_url || null : null,
    providerUrl: sandbox ? 'https://www.escrow-sandbox.com/login-page' : 'https://www.escrow.com/login-page',
    transactionId: order.escrow_transaction_id, createdAt: order.created_at, verifiedAt: order.provider_verified_at };
}
