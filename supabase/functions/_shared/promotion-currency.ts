import type Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { PROMOTION_COUNTRY_CURRENCIES } from './promotion-countries.ts';

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
// These currencies require whole units represented as multiples of 100. Use USD
// until the custom Tax flow supports their special rounding requirements.
const SPECIAL_ROUNDING = new Set(['ISK', 'UGX']);
const DAY_MS = 24 * 60 * 60 * 1000;
type Rates = { rates: Record<string, number>; updatedAt: number; expiresAt: number };
let promotionRates: Rates | null = null;
let promotionRatesLoading: Promise<Rates> | null = null;
let promotionSupportedCurrencies: { values: Set<string>; expiresAt: number } | null = null;

export class PromotionCurrencyError extends Error {
  status = 503;
}

export function promotionCurrencyScale(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}

async function getPromotionRates(): Promise<Rates> {
  if (promotionRates && promotionRates.expiresAt > Date.now()) return promotionRates;
  if (promotionRatesLoading) return promotionRatesLoading;
  promotionRatesLoading = (async () => {
    try {
      const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Exchange rate service unavailable.');
      const data = await response.json();
      const updatedAt = Number(data.time_last_update_unix) * 1000;
      const nextUpdate = Number(data.time_next_update_unix) * 1000;
      if (data.result !== 'success' || data.base_code !== 'USD' || data.rates?.USD !== 1
        || !Number.isFinite(updatedAt) || updatedAt > Date.now() + 60000 || Date.now() - updatedAt > 2 * DAY_MS) {
        throw new Error('Exchange rates are out of date.');
      }
      promotionRates = {
        rates: data.rates, updatedAt,
        expiresAt: Number.isFinite(nextUpdate) && nextUpdate > Date.now()
          ? Math.min(nextUpdate, Date.now() + DAY_MS) : Date.now() + 60 * 60 * 1000,
      };
      return promotionRates;
    } catch {
      throw new PromotionCurrencyError('Currency conversion is temporarily unavailable. Please try again before paying.');
    }
  })();
  try { return await promotionRatesLoading; } finally { promotionRatesLoading = null; }
}

async function getSupportedPromotionCurrencies(stripe: Stripe): Promise<Set<string>> {
  if (promotionSupportedCurrencies && promotionSupportedCurrencies.expiresAt > Date.now()) return promotionSupportedCurrencies.values;
  const account = await stripe.accounts.retrieve();
  if (!account.country) throw new PromotionCurrencyError('Unable to verify the payment account currency support.');
  const spec = await stripe.countrySpecs.retrieve(account.country);
  const values = new Set(spec.supported_payment_currencies.map(value => value.toUpperCase()));
  if (!values.has('USD')) throw new PromotionCurrencyError('USD payments are unavailable for this account.');
  promotionSupportedCurrencies = { values, expiresAt: Date.now() + DAY_MS };
  return values;
}

export async function quotePromotionCurrency(
  stripe: Stripe,
  { country, baseUsdCents, subtotalUsdCents }: { country: string; baseUsdCents: number; subtotalUsdCents: number },
) {
  const localCurrency = PROMOTION_COUNTRY_CURRENCIES[country.toUpperCase()] || 'USD';
  const supported = localCurrency === 'USD' ? null : await getSupportedPromotionCurrencies(stripe);
  const currency = localCurrency !== 'USD' && supported?.has(localCurrency) && !SPECIAL_ROUNDING.has(localCurrency)
    ? localCurrency : 'USD';
  const rates = currency === 'USD' ? null : await getPromotionRates();
  const exchangeRate = rates ? Number(rates.rates[currency]) : 1;
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new PromotionCurrencyError('The exchange rate for your billing currency is unavailable. Please try again.');
  }
  const scale = promotionCurrencyScale(currency);
  const convert = (cents: number) => Math.round(cents / 100 * exchangeRate * scale);
  const baseAmountMinor = convert(baseUsdCents);
  const subtotalMinor = convert(subtotalUsdCents);
  if (!Number.isSafeInteger(baseAmountMinor) || !Number.isSafeInteger(subtotalMinor) || subtotalMinor <= 0 || subtotalMinor > baseAmountMinor) {
    throw new PromotionCurrencyError('Unable to verify the converted payment amount.');
  }
  return {
    currency: currency.toLowerCase(), currencyScale: scale, baseAmountMinor, subtotalMinor,
    discountMinor: baseAmountMinor - subtotalMinor, exchangeRate,
    exchangeRateUpdatedAt: rates ? new Date(rates.updatedAt).toISOString() : null,
    billingCountry: country, localCurrency, currencyFallback: currency !== localCurrency,
  };
}
